import { describe, expect, it } from "vitest";
import type { JsonRpcMessage } from "../src/protocol/jsonrpc.ts";
import { consumeSseStream, type SseEvent, StreamableHttpTransport } from "../src/transports/streamable-http.ts";

const encoder = new TextEncoder();

async function readEvents(chunks: readonly Uint8Array[]): Promise<SseEvent[]> {
	const events: SseEvent[] = [];
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	await consumeSseStream(stream, { onEvent: (event) => events.push(event) });
	return events;
}

// Regression for #11522: valid CR framing must deliver MCP messages before EOF.
describe("SSE line endings", () => {
	it.each(["\n", "\r\n", "\r"])("separates successive events with %j", async (ending) => {
		const bytes = encoder.encode(`data: first${ending}${ending}data: second${ending}${ending}`);
		expect(await readEvents([bytes])).toEqual([{ data: "first" }, { data: "second" }]);
	});

	it("keeps CRLF pairs together at every byte boundary, including empty chunks", async () => {
		const bytes = encoder.encode(
			'id: 7\r\nevent: message\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\ndata: done\r\n\r\n',
		);
		for (let split = 0; split <= bytes.length; split++) {
			expect(await readEvents([bytes.slice(0, split), new Uint8Array(), bytes.slice(split)])).toEqual([
				{ event: "message", id: "7", data: '{"text":\n"你好"}' },
				{ data: "done" },
			]);
		}
	});

	it("accepts mixed line endings one byte at a time", async () => {
		const bytes = encoder.encode("data: first\rdata: second\n\r\ndata: third\r\r");
		expect(await readEvents(Array.from(bytes, (byte) => Uint8Array.of(byte)))).toEqual([
			{ data: "first\nsecond" },
			{ data: "third" },
		]);
	});

	it("parses CR-terminated metadata and multiline data", async () => {
		const ids: string[] = [];
		const retries: number[] = [];
		const events: SseEvent[] = [];
		await consumeSseStream(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(": comment\rid: 7\revent: message\rretry: 25\rdata: first\rdata: second\r\r"),
					);
					controller.close();
				},
			}),
			{
				onEvent: (event) => events.push(event),
				onId: (id) => ids.push(id),
				onRetry: (delay) => retries.push(delay),
			},
		);
		expect(events).toEqual([{ event: "message", id: "7", data: "first\nsecond" }]);
		expect(ids).toEqual(["7"]);
		expect(retries).toEqual([25]);
	});

	it("dispatches CR-terminated events before a live stream closes", async () => {
		let closeStream = () => {};
		let readNextChunk = () => {};
		const nextRead = new Promise<void>((resolve) => {
			readNextChunk = resolve;
		});
		const stream = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					controller.enqueue(encoder.encode("data: first\r\rdata: second\r\r"));
					closeStream = () => controller.close();
				},
				pull() {
					readNextChunk();
				},
			},
			{ highWaterMark: 0 },
		);
		const events: SseEvent[] = [];
		const consuming = consumeSseStream(stream, { onEvent: (event) => events.push(event) });
		try {
			await nextRead;
			expect(events).toEqual([{ data: "first" }, { data: "second" }]);
		} finally {
			closeStream();
			await consuming;
		}
	});

	it("enforces the data byte limit across CR-terminated lines", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("data: first\rdata: second\r\r"));
				controller.close();
			},
		});
		await expect(consumeSseStream(stream, { maxEventBytes: 11, onEvent: () => {} })).rejects.toThrow(
			"MCP SSE event exceeds 11 bytes",
		);
		expect(stream.locked).toBe(false);
	});

	it("delivers an MCP response after a CR-terminated notification", async () => {
		const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
		const response = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
		const transport = new StreamableHttpTransport({
			url: "https://mcp.example.test",
			openGetStream: false,
			fetch: async () =>
				new Response(`data: ${JSON.stringify(notification)}\r\rdata: ${JSON.stringify(response)}\r\r`, {
					headers: { "content-type": "text/event-stream" },
				}),
		});
		const messages: JsonRpcMessage[] = [];
		const answer = new Promise<JsonRpcMessage>((resolve) => {
			transport.onMessage((message) => {
				messages.push(message);
				if ("id" in message && message.id === 1) resolve(message);
			});
		});
		await transport.start();
		try {
			await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
			expect(await answer).toEqual(response);
			expect(messages).toEqual([notification, response]);
		} finally {
			await transport.close();
		}
	});
});
