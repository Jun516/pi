import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { StdioTransport } from "../src/transports/stdio.ts";

// Acknowledge each byte before the child emits the next, so pipe coalescing cannot hide a split character.
const fixture = String.raw`
const bytes = Buffer.from(process.argv[1], "base64");
let sent = 0;
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	input += chunk;
	let newline = input.indexOf("\n");
	while (newline >= 0) {
		input = input.slice(newline + 1);
		if (sent < bytes.length) process.stderr.write(bytes.subarray(sent, ++sent));
		newline = input.indexOf("\n");
	}
});
process.stdin.on("end", () => process.exit(0));
`;

const cases = [
	{ name: "ASCII output", bytes: Buffer.from("ready\n") },
	{ name: "Chinese three-byte characters", bytes: Buffer.from("你好\n") },
	{ name: "four-byte characters", bytes: Buffer.from("\u{1f642}\n") },
	{ name: "mixed ASCII and Unicode", bytes: Buffer.from("prefix 你好 \u{1f642} suffix\n") },
	{ name: "incomplete two-byte tail", bytes: Buffer.from([0x61, 0xe4, 0xbd]) },
	{ name: "intrinsically invalid bytes", bytes: Buffer.from([0xff, 0xfe]) },
	{ name: "incomplete single-byte tail", bytes: Buffer.from([0x61, 0xe4]) },
	{ name: "bounded retained stderr", bytes: Buffer.from("left 你好\u{1f642} :end\n"), maxStderrBytes: 5 },
] as const;

describe("StdioTransport stderr decoding", () => {
	for (const testCase of cases) {
		it(`decodes ${testCase.name} across byte boundaries`, async () => {
			const chunks: string[] = [];
			const events: string[] = [];
			let receivedBytes = 0;
			let complete = () => {};
			let fail = (_error: unknown) => {};
			const done = new Promise<void>((resolve, reject) => {
				complete = resolve;
				fail = reject;
			});
			const maxStderrBytes = "maxStderrBytes" in testCase ? testCase.maxStderrBytes : 64 * 1024;
			const transport = new StdioTransport({
				command: process.execPath,
				args: ["-e", fixture, testCase.bytes.toString("base64")],
				maxStderrBytes,
				onStderr: (chunk) => {
					chunks.push(chunk);
					events.push(`stderr:${chunk}`);
				},
			});
			transport.onClose(() => events.push("close"));
			const timeout = setTimeout(() => fail(new Error("Child fixture timed out")), 5000);
			try {
				await transport.start();
				const child = (transport as unknown as { child: ChildProcess }).child;
				if (!child.stderr) throw new Error("Child stderr pipe is unavailable");
				child.stderr.on("data", (chunk: Buffer) => {
					receivedBytes += chunk.length;
					if (receivedBytes >= testCase.bytes.length) complete();
					else void transport.send({ jsonrpc: "2.0", method: "continue" }).catch(fail);
				});
				await transport.send({ jsonrpc: "2.0", method: "continue" });
				await done;
			} finally {
				clearTimeout(timeout);
				await transport.close();
			}
			expect(chunks.join("")).toBe(testCase.bytes.toString("utf8"));
			expect(transport.stderr).toBe(testCase.bytes.subarray(-maxStderrBytes).toString("utf8"));
			expect(events.at(-1)).toBe("close");
			expect(events.filter((event) => event === "close")).toHaveLength(1);
		});
	}
});
