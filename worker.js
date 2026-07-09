// odottar API + 静的アセット配信
// /api/counts (GET) いいね数マップ / /api/hit?k=名前 (POST) 加算
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/counts") {
      const data = (env.LIKES && await env.LIKES.get("counts")) || "{}";
      return json(data, 200);
    }
    if (url.pathname === "/api/hit" && request.method === "POST") {
      const k = url.searchParams.get("k");
      if (!k) return json(JSON.stringify({ error: "missing k" }), 400);
      if (!env.LIKES) return json(JSON.stringify({ error: "KV not bound" }), 500);
      const raw = await env.LIKES.get("counts");
      const obj = raw ? JSON.parse(raw) : {};
      obj[k] = (obj[k] || 0) + 1;
      await env.LIKES.put("counts", JSON.stringify(obj));
      return json(JSON.stringify({ count: obj[k] }), 200);
    }
    return env.ASSETS.fetch(request);
  }
};
function json(body, status) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
