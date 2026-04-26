const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NOTION_API_KEY     = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_PARENT_PAGE = process.env.NOTION_PARENT_PAGE;

if (!ANTHROPIC_API_KEY || !NOTION_API_KEY) {
  console.error("❌ 환경변수 ANTHROPIC_API_KEY, NOTION_API_KEY 가 설정되지 않았습니다.");
  process.exit(1);
}

async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

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

async function searchNewVideos(existingUrls, targetCount = 5) {
  const today = new Date().toISOString().slice(0, 10);
  const excludeList = [...existingUrls].slice(0, 50).join("\n");

  const systemPrompt = `당신은 YouTube 영상 검색 전문가입니다. 반드시 web_search 툴을 사용하여 실제 YouTube 영상을 검색한 후, 결과를 JSON 배열로만 반환하세요. 절대 검색 없이 응답하지 마세요.`;

  const userPrompt = `web_search 툴로 YouTube에서 아래 키워드로 검색해주세요:
- "Claude AI tutorial 2026"
- "Anthropic Claude 사용법"

조건:
- 최근 90일 이내 영상
- 아래 URL 제외: ${excludeList || "(없음)"}

검색 완료 후 반드시 아래 JSON 배열 형식으로만 답하세요. 다른 텍스트 없이 JSON만:
[{"title":"","url":"https://youtube.com/watch?v=...","channel":"","views":"","duration":"","publishedDate":"YYYY-MM-DD","summary":"한국어 요약"}]

최대 ${targetCount}개`;

  let messages = [{ role: "user", content: userPrompt }];

  for (let turn = 0; turn < 8; turn++) {
    const data = await apiFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: systemPrompt,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages,
      }),
    });

    console.log(`  [턴 ${turn + 1}] stop_reason: ${data.stop_reason}, 블록수: ${data.content?.length}`);
    messages.push({ role: "assistant", content: data.content });

    if (data.stop_reason === "end_turn") {
      const rawText = data.content?.find((b) => b.type === "text")?.text || "";
      console.log("최종 응답 미리보기:", rawText.slice(0, 300));
      try {
        const cleaned = rawText.replace(/```json|```/g, "").trim();
        const match = cleaned.match(/\[[\s\S]*\]/);
        const videos = JSON.parse(match?.[0] || "[]");
        return videos.filter((v) => v.url && !existingUrls.has(v.url.trim()));
      } catch {
        console.error("❌ JSON 파싱 실패");
        return [];
      }
    }

    if (data.stop_reason === "tool_use") {
      const toolUseBlocks = data.content.filter((b) => b.type === "tool_use");
      const toolResults = toolUseBlocks.map((b) => ({
        type: "tool_result",
        tool_use_id: b.id,
        content: "검색이 실행되었습니다. 검색 결과를 바탕으로 JSON 배열을 반환해주세요.",
      }));
      messages.push({ role: "user", content: toolResults });
    }
  }

  return [];
}

async function analyzeVideo(video) {
  const data = await apiFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `YouTube 영상 핵심 분석 (한국어):
제목: ${video.title}
채널: ${video.channel}
요약: ${video.summary}

형식:
**핵심 주제**: (1줄)
**학습 포인트**: (불릿 3개)
**활용법**: (불릿 2개)
**대상**: (1줄)
**추천도**: ⭐⭐⭐⭐`,
      }],
    }),
  });
  return data.content?.find((b) => b.type === "text")?.text || "(분석 실패)";
}

async function createDailySummaryPage(videos, today) {
  const korDate = new Date(today).toLocaleDateString("ko-KR", {
    year: "numeric", month: "long", day: "numeric",
  });

  const content = [
    `수집일: ${korDate} | 신규 영상: ${videos.length}개 | GitHub Actions + Claude AI 자동화`,
    ``,
    ...videos.flatMap((v, i) => [
      `[${i + 1}위] ${v.title}`,
      `채널: ${v.channel} | 조회수: ${v.views} | 길이: ${v.duration} | 업로드: ${v.publishedDate}`,
      `URL: ${v.url}`,
      ``,
      v.analysis || "",
      ``,
      `---`,
      ``,
    ]),
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
    children: [{
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: content.slice(0, 2000) } }] },
    }],
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
          Channel: { rich_text: [{ text: { content: v.channel || "" } }] },
          Views:   { rich_text: [{ text: { content: v.views || "" } }] },
          CollectedDate: { date: { start: today } },
        },
      }),
    });
  }
  console.log(`✅ DB에 ${videos.length}개 영상 저장 완료`);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n🚀 자동화 시작 — ${today}\n`);

  console.log("📂 [1/4] 기존 수집 URL 확인 중...");
  const existingUrls = await getExistingUrls();

  console.log("🔍 [2/4] 신규 YouTube 영상 검색 중...");
  const newVideos = await searchNewVideos(existingUrls, 5);

  if (newVideos.length === 0) {
    console.log("ℹ️  신규 영상이 없습니다. 오늘은 업로드를 건너뜁니다.");
    return;
  }
  console.log(`✅ 신규 영상 ${newVideos.length}개 발견`);

  console.log("📝 [3/4] 핵심 내용 분석 중...");
  for (let i = 0; i < newVideos.length; i++) {
    console.log(`  ↳ [${i + 1}/${newVideos.length}] ${newVideos[i].title}`);
    newVideos[i].analysis = await analyzeVideo(newVideos[i]);
  }

  console.log("📤 [4/4] 노션 업로드 중...");
  const pageUrl = await createDailySummaryPage(newVideos, today);
  await saveVideosToDB(newVideos, today);

  console.log(`\n✅ 완료! 노션 페이지: ${pageUrl}\n`);
}

main().catch((e) => {
  console.error("❌ 치명적 오류:", e.message);
  process.exit(1);
});
