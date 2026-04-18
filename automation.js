/**
 * Claude YouTube → Notion 자동화 스크립트
 * - 노션에서 기존 수집 영상 URL 목록을 읽어 중복 제외
 * - 신규 영상만 검색 → 분석 → 노션 업로드
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY     = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID; // 영상 DB (URL 중복 체크용)
const NOTION_PARENT_PAGE = process.env.NOTION_PARENT_PAGE; // 일별 요약 페이지의 부모

if (!ANTHROPIC_API_KEY || !NOTION_API_KEY) {
  console.error("❌ 환경변수 ANTHROPIC_API_KEY, NOTION_API_KEY 가 설정되지 않았습니다.");
  process.exit(1);
}

// ─────────────────────────────────────────────
// 공통 fetch 헬퍼
// ─────────────────────────────────────────────
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

// ─────────────────────────────────────────────
// 1. Notion: 기존 수집된 URL 목록 조회
// ─────────────────────────────────────────────
async function getExistingUrls() {
  if (!NOTION_DATABASE_ID) {
    console.log("⚠️  NOTION_DATABASE_ID 미설정 — 중복 체크 건너뜀");
    return new Set();
  }

  const collected = new Set();
  let cursor = undefined;

  while (true) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const data = await apiFetch(
      `https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );

    for (const page of data.results) {
      const urlProp = page.properties?.URL?.url
        || page.properties?.["YouTube URL"]?.url
        || page.properties?.url?.url;
      if (urlProp) collected.add(urlProp.trim());
    }

    if (!data.has_more) break;
    cursor = data.next_cursor;
  }

  console.log(`✅ 기존 수집 URL ${collected.size}개 로드 완료`);
  return collected;
}

// ─────────────────────────────────────────────
// 2. Claude: 신규 영상 검색 (중복 제외)
// ─────────────────────────────────────────────
async function searchNewVideos(existingUrls, targetCount = 5) {
  const today = new Date().toISOString().slice(0, 10);
  const excludeList = [...existingUrls].slice(0, 50).join("\n");

  const messages = [
    {
      role: "user",
      content: `오늘(${today}) 기준으로 YouTube에서 "Claude AI 사용법", "Claude AI tutorial", "Anthropic Claude 교육" 관련 최신 영상을 검색해줘.

【중요 조건】
- 최근 30일 이내 업로드된 영상 우선
- 조회수 높은 순서로 선별
- 아래 URL 목록은 이미 수집된 영상이므로 반드시 제외:
${excludeList || "(없음 — 최초 실행)"}

결과는 반드시 아래 JSON 배열 형식으로만 답해. 마크다운 없이 순수 JSON만.
[
  {
    "title": "영상 제목",
    "url": "https://youtube.com/watch?v=...",
    "channel": "채널명",
    "views": "조회수 (예: 15만 회)",
    "duration": "영상 길이 (예: 18:42)",
    "publishedDate": "YYYY-MM-DD",
    "summary": "2~3문장 요약 (한국어)",
    "isNew": true
  }
]

목표: 신규 영상 최대 ${targetCount}개. 신규 영상이 ${targetCount}개 미만이면 있는 것만 반환.`,
    },
  ];

  const data = await apiFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 2000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages,
    }),
  });

  const text = data.content?.find((b) => b.type === "text")?.text || "[]";
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    const videos = JSON.parse(match?.[0] || "[]");
    // 혹시라도 기존 URL이 포함된 경우 한번 더 필터
    return videos.filter((v) => !existingUrls.has(v.url?.trim()));
  } catch {
    console.error("❌ 영상 목록 파싱 실패:", text.slice(0, 300));
    return [];
  }
}

// ─────────────────────────────────────────────
// 3. Claude: 각 영상 핵심 분석
// ─────────────────────────────────────────────
async function analyzeVideo(video) {
  const data = await apiFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: `다음 YouTube 영상의 핵심 내용을 한국어로 분석해줘:

제목: ${video.title}
채널: ${video.channel}
URL: ${video.url}
기본 요약: ${video.summary}

아래 형식으로 정리해줘:
**핵심 주제**: (1~2줄)

**주요 학습 포인트**:
- 포인트 1
- 포인트 2
- 포인트 3

**실용 활용법**:
- 활용법 1
- 활용법 2

**대상 시청자**: (누가 보면 좋을지 한 줄)

**추천도**: ⭐⭐⭐⭐ (이유 한 줄)`,
        },
      ],
    }),
  });

  return data.content?.find((b) => b.type === "text")?.text || "(분석 실패)";
}

// ─────────────────────────────────────────────
// 4. Notion: 일별 요약 페이지 생성
// ─────────────────────────────────────────────
async function createDailySummaryPage(videos, today) {
  const korDate = new Date(today).toLocaleDateString("ko-KR", {
    year: "numeric", month: "long", day: "numeric",
  });

  const content = [
    `# 🎬 Claude AI 신규 유튜브 영상 TOP ${videos.length}`,
    `**수집일**: ${korDate}  `,
    `**신규 영상**: ${videos.length}개  `,
    `**자동화**: GitHub Actions → Claude AI → Notion`,
    ``,
    `---`,
    ``,
    ...videos.flatMap((v, i) => [
      `## ${i + 1}위. ${v.title}`,
      ``,
      `| 항목 | 내용 |`,
      `|------|------|`,
      `| 채널 | ${v.channel} |`,
      `| 조회수 | ${v.views} |`,
      `| 영상 길이 | ${v.duration} |`,
      `| 업로드일 | ${v.publishedDate} |`,
      `| URL | [▶ 영상 보기](${v.url}) |`,
      ``,
      `### 📊 핵심 분석`,
      ``,
      v.analysis,
      ``,
      `---`,
      ``,
    ]),
    `> 🤖 이 페이지는 GitHub Actions + Claude AI로 매일 자동 생성됩니다.`,
  ].join("\n");

  const body = {
    parent: NOTION_PARENT_PAGE
      ? { page_id: NOTION_PARENT_PAGE }
      : { type: "workspace", workspace: true },
    properties: {
      title: {
        title: [{ text: { content: `[자동] Claude 신규 영상 TOP${videos.length} — ${korDate}` } }],
      },
    },
    children: [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content } }],
        },
      },
    ],
  };

  const page = await apiFetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return page.url || page.id;
}

// ─────────────────────────────────────────────
// 5. Notion: 영상 DB에 신규 영상 행 추가 (중복 추적용)
// ─────────────────────────────────────────────
async function saveVideosToDB(videos, today) {
  if (!NOTION_DATABASE_ID) return;

  for (const v of videos) {
    await apiFetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: v.title } }] },
          URL:  { url: v.url },
          Channel: { rich_text: [{ text: { content: v.channel } }] },
          Views:   { rich_text: [{ text: { content: v.views } }] },
          CollectedDate: { date: { start: today } },
        },
      }),
    });
  }
  console.log(`✅ DB에 ${videos.length}개 영상 저장 완료`);
}

// ─────────────────────────────────────────────
// 메인 실행
// ─────────────────────────────────────────────
async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n🚀 자동화 시작 — ${today}\n`);

  // Step 1: 기존 URL 로드
  console.log("📂 [1/4] 기존 수집 URL 확인 중...");
  const existingUrls = await getExistingUrls();

  // Step 2: 신규 영상 검색
  console.log("🔍 [2/4] 신규 YouTube 영상 검색 중...");
  const newVideos = await searchNewVideos(existingUrls, 5);

  if (newVideos.length === 0) {
    console.log("ℹ️  신규 영상이 없습니다. 오늘은 업로드를 건너뜁니다.");
    return;
  }
  console.log(`✅ 신규 영상 ${newVideos.length}개 발견`);

  // Step 3: 각 영상 분석
  console.log("📝 [3/4] 핵심 내용 분석 중...");
  for (let i = 0; i < newVideos.length; i++) {
    const v = newVideos[i];
    console.log(`  ↳ [${i + 1}/${newVideos.length}] ${v.title}`);
    v.analysis = await analyzeVideo(v);
  }

  // Step 4: 노션 업로드
  console.log("📤 [4/4] 노션 업로드 중...");
  const pageUrl = await createDailySummaryPage(newVideos, today);
  await saveVideosToDB(newVideos, today);

  console.log(`\n✅ 완료! 노션 페이지: ${pageUrl}\n`);
}

main().catch((e) => {
  console.error("❌ 치명적 오류:", e.message);
  process.exit(1);
});
