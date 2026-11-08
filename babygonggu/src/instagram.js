// 인스타그램 공식 Graph API 클라이언트 (Business Discovery).
// 내 프로페셔널 계정(IG_USER_ID)과 토큰으로, 다른 프로페셔널 계정의 프로필과 최근 게시물을 읽는다.
// https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery

export class GraphError extends Error {
  constructor(message, { code, subcode, status } = {}) {
    super(message);
    this.code = code;
    this.subcode = subcode;
    this.status = status;
  }
  /** 프로페셔널 계정이 아니거나 없는 계정 */
  get notFound() { return this.code === 110 || this.subcode === 2207013 || (this.code === 100 && /cannot be found|does not exist/i.test(this.message)); }
  /** 호출 한도 초과: 이번 수집은 멈춰야 함 */
  get rateLimited() { return [4, 17, 32, 613, 80002].includes(this.code); }
  /** 토큰 만료·무효: 설정을 고쳐야 함 */
  get authFailed() { return this.code === 190 || this.status === 401; }
}

/**
 * @param {{userId: string, token?: string, version?: string, fetchImpl?: typeof fetch}} opts
 *  token: 비워두면 Authorization 헤더를 프록시가 넣어준다고 보고 더미 값을 보낸다.
 */
export function createGraphClient({ userId, token, version = 'v21.0', fetchImpl = fetch }) {
  const base = `https://graph.facebook.com/${version}`;
  return {
    async profile(username, { mediaLimit = 30 } = {}) {
      const fields = `business_discovery.username(${username}){username,name,biography,followers_count,media_count,`
        + `media.limit(${mediaLimit}){caption,permalink,timestamp,media_type}}`;
      let url = `${base}/${encodeURIComponent(userId)}?fields=${encodeURIComponent(fields)}`;
      // 토큰이 있으면 Graph API 표준 방식(access_token 파라미터), 없으면 프록시가 Authorization 헤더를 채운다
      if (token) url += `&access_token=${encodeURIComponent(token)}`;
      const res = await fetchImpl(url, token ? {} : { headers: { authorization: 'Bearer injected-by-proxy' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.error) {
        const e = body.error || {};
        throw new GraphError(e.error_user_msg || e.message || `HTTP ${res.status}`, { code: e.code, subcode: e.error_subcode, status: res.status });
      }
      const bd = body.business_discovery || {};
      return {
        username: (bd.username || username).toLowerCase(),
        name: bd.name || '',
        bio: bd.biography || '',
        followers: bd.followers_count ?? null,
        media_count: bd.media_count ?? null,
        media: (bd.media?.data || []).map((m) => ({ caption: m.caption || '', permalink: m.permalink, timestamp: m.timestamp })),
      };
    },
  };
}

export function graphClientFromEnv(env = process.env) {
  if (!env.IG_USER_ID) return null;
  return createGraphClient({ userId: env.IG_USER_ID, token: env.IG_ACCESS_TOKEN || '', version: env.IG_GRAPH_VERSION || 'v21.0' });
}
