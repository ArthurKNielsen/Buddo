// Runs the in-browser model off the main thread, so typing, scrolling and animations stay smooth while it thinks.
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
