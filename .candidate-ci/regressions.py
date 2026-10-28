"""Run real old-production/new-test controls, restore, then verify each candidate."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.candidate-results'
OUT.mkdir(exist_ok=True)
BASE='a92283056d915c758799fcd904948ff0cb42628c'
cases=[
    ('fullscreen','coding-agent','src/modes/interactive/interactive-mode.ts','test/interactive-mode-model-scope.test.ts',2,2),
    ('mcp-sse','mcp','src/transports/streamable-http.ts','test/sse-line-endings.test.ts',5,4),
]
summary=[]
for name,pkg,production,test,expected_fail,expected_pass in cases:
    path=ROOT/'packages'/pkg/production
    fixed=path.read_bytes()
    original=subprocess.run(['git','show',f'{BASE}:packages/{pkg}/{production}'],capture_output=True,check=True).stdout
    results={}
    try:
        for variant,source in [('original',original),('fixed',fixed)]:
            path.write_bytes(source)
            report=OUT/f'{name}-{variant}.json'
            command=['node',str(ROOT/'node_modules/vitest/dist/cli.js'),'--run',test,'--reporter=json',f'--outputFile={report}']
            run=subprocess.run(command,cwd=ROOT/'packages'/pkg,capture_output=True,text=True)
            (OUT/f'{name}-{variant}.log').write_text(run.stdout+run.stderr,encoding='utf-8')
            print(f'{name} {variant}: exit={run.returncode}',flush=True)
            print(run.stdout,flush=True)
            print(run.stderr,flush=True)
            data=json.loads(report.read_text(encoding='utf-8'))
            results[variant]={'exit':run.returncode,'failed':data['numFailedTests'],'passed':data['numPassedTests'],'total':data['numTotalTests'],'failed_suites':data['numFailedTestSuites'],'runtime_error_suites':data.get('numRuntimeErrorTestSuites',0)}
    finally:
        path.write_bytes(fixed)
    row={'candidate':name,'fixed_sha256':hashlib.sha256(fixed).hexdigest(),'fixed_restored':path.read_bytes()==fixed,'results':results}
    summary.append(row)
    (OUT/'controls.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    assert results['original']['exit'] != 0
    assert results['original']['runtime_error_suites'] == 0, 'Startup errors are not a regression witness'
    assert results['original']['failed']==expected_fail and results['original']['passed']==expected_pass, results
    assert results['fixed']['exit']==0 and results['fixed']['failed']==0
    assert results['fixed']['passed']==expected_fail+expected_pass
    assert row['fixed_restored']
print(json.dumps(summary,indent=2),flush=True)
