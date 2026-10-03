/** Fetch §4.4 HTTP-redirect fetch step 12, self-contained (bridge.js carries its source): null = not a redirect status. */
export function redirectStep(status: number, method: string): { method: string; body: boolean } | null {
    if (![301, 302, 303, 307, 308].includes(status)) return null;
    if (((status === 301 || status === 302) && method === "POST") || (status === 303 && method !== "GET" && method !== "HEAD")) return { method: "GET", body: false };
    return { method, body: true };
}
