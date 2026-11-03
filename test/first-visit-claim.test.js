import test from "node:test";
import assert from "node:assert/strict";
import { isFirstVisitClaim, normalizeFirstVisitClaim } from "../lib/first-visit-claim.js";

test("recognizes common first-visit claims and spelling variations", () => {
  const claims = [
    "初見",
    "初見です",
    "初見です🙂‍↕️",
    "こんばんわ〜初見です🥰",
    "初見ですやりたいです！",
    "初見です。フォローしてハートミーしました😊",
    "初見でーす！",
    "初見ですよー",
    "しょけんです",
    "初見でござる",
    "初見です。よろしくお願いします！",
    "この枠初見です",
    "はじめまして",
    "初めまして！よろしくお願いします",
    "お初です",
    "初訪問です",
    "初めて来ました",
    "はじめて来たよ",
    "この配信はじめて見に来ました",
  ];
  for (const claim of claims) assert.equal(isFirstVisitClaim(claim), true, claim);
});

test("does not react to questions, greetings aimed at others, or admitted jokes", () => {
  const nonClaims = [
    "初見ですか？",
    "初見さんいらっしゃい",
    "初見ではありません",
    "初見じゃないです",
    "初見詐欺です",
    "初見のふりをしました",
    "はじめましてじゃないけどよろしく",
    "初見さんいる？",
    "こんばんわ初見さんいらっしゃい🥰",
    "初見ではないですが参加したいです",
    "初見ですけど、どう言うことですか？？",
    "フォローしてハートミーしました😊",
  ];
  for (const claim of nonClaims) assert.equal(isFirstVisitClaim(claim), false, claim);
});

test("normalization absorbs punctuation, spaces, emoji, and long sound marks", () => {
  assert.equal(normalizeFirstVisitClaim(" 初見 で〜す 🙋 "), "初見です");
  assert.equal(normalizeFirstVisitClaim("初見です🙂‍↕️"), "初見です");
});
