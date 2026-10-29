export type RequestTransport = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let transport: RequestTransport | undefined;

/** The normal application always uses the browser's same-origin HTTP client. */
export function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return transport ? transport(input, init) : globalThis.fetch(input, init);
}

/** Installed only by the separate, static demonstration entry point. */
export function setRequestTransport(next?: RequestTransport): void {
  transport = next;
}
