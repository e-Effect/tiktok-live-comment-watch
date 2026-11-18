import test from "node:test";
import assert from "node:assert/strict";
import { validReportDay, sanitizeComment, createDailyCommentReport } from "../lib/comment-ai-report.js";

test("validates calendar days and Japanese timezone input", () => {
  assert.equal(validReportDay("2026-11-19"), true);
  assert.equal(validReportDay("2026-02-30"), false);
  assert.equal(validReportDay("19-11-2026"), false);
});

test("masks basic contact details without retaining newlines", () => {
  const s = sanitizeComment("連絡 a@example.com https://example.com\n090-1234-5678");
  assert.ok(!s.includes("a@example.com"));
  assert.ok(!s.includes("https://"));
  assert.ok(!s.includes("090-1234-5678"));
  assert.ok(!s.includes("\n"));
});

test("uses bounded read, sends only comment bodies, and reports API token use", async () => {
  let queryArgs, request;
  const pool = { query: async (_sql, args) => {
    queryArgs = args;
    return { rows: [{ comment_text: "楽しかった" }, { comment_text: "また配信して" }] };
  }};
  const fetchImpl = async (_url, options) => {
    request = options;
    return { ok:true, json:async()=>({
      output:[{content:[{type:"output_text",text:"話題を分析しました"}]}],
      usage:{input_tokens:200,output_tokens:100}
    })};
  };
  const report = await createDailyCommentReport({pool,username:"mentalist_k",day:"2026-11-18",apiKey:"test-only",fetchImpl});
  assert.equal(queryArgs[0],"mentalist_k");
  assert.equal(queryArgs[3],3001);
  assert.equal(report.analyzedComments,2);
  assert.equal(report.text,"話題を分析しました");
  assert.ok(report.estimatedUsd > 0);
  assert.equal(JSON.parse(request.body).model, "gpt-6-luna");
  assert.ok(!request.body.includes("userId"));
  assert.ok(!request.body.includes("nickname"));
});

test("does not charge API when no comments exist", async () => {
  const pool = {query:async()=>({rows:[]})};
  const report = await createDailyCommentReport({
    pool,username:"mentalist_k",day:"2026-11-18",apiKey:"test-only",
    fetchImpl:()=>{throw new Error("fetch should not be called");}
  });
  assert.equal(report.analyzedComments,0);
  assert.equal(report.estimatedUsd,0);
});
