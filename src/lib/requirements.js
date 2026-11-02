'use strict';

const { cleanText } = require('./util');

const REQUIREMENT_PATTERNS = [
  {
    type: 'level',
    // "requires level 50", "must be level 50", "level 50+", "Lv. 50 to claim"
    re: /(?:requires?|required|need(?:s|ed)?|must\s+(?:be|have|reach)|reach|at\s+least|minimum|be)\s*(?:at\s+least\s*)?(?:level|lvl\.?|lvl)\s*[:#]?\s*(\d+)|(?:level|lvl\.?)\s*[:#]?\s*(\d+)\s*\+|等级\s*[:：]?\s*(\d+)/i,
    build: (match) => {
      const amount = match[1] || match[2] || match[3];
      return { type: 'level', label: `等级 ${amount}+`, detail: cleanText(match[0]) };
    },
  },
  {
    type: 'group',
    re: /(?:join|be\s+in|be\s+part\s+of|in|members?\s+of)\s+(?:the\s+|our\s+|this\s+)?(?:roblox\s+)?(?:[\w'-]+\s+){0,4}group\b|group\s+(?:members?\s+)?(?:only|required)|requires?\s+(?:a\s+)?(?:roblox\s+)?group|加入(?:该|本|游戏)?群组|需要加入群组|群组成员/i,
    build: () => ({ type: 'group', label: '需加入群组', detail: '需要先加入游戏的 Roblox 群组' }),
  },
  {
    type: 'discord',
    re: /(?:join|be\s+in|in)\s+(?:the\s+|our\s+)?discord(?:\s+server)?|discord\s+(?:server\s+)?(?:only|required|members?)|加入\s*discord/i,
    build: () => ({ type: 'discord', label: '需加入 Discord', detail: '需要先加入官方 Discord 服务器' }),
  },
  {
    type: 'follow',
    re: /(?:follow|subscribe|like|sub(?:scribe)?\s+to)\s+(?:the\s+|our\s+)?(?:creator|game|channel|youtube|twitter|x\.com|twitch|tiktok|instagram|facebook)|(?:must\s+)?(?:follow|subscribe)\s+(?:the\s+|our\s+)?(?:creator|channel|youtube|twitter|twitch|tiktok)|关注(?:作者|频道|推特|youtube)|订阅(?:频道|作者)/i,
    build: () => ({ type: 'follow', label: '需关注/订阅', detail: '需要关注作者或订阅社交频道' }),
  },
  {
    type: 'gamepass',
    re: /(?:own|owning|requires?|need)\s+(?:the\s+|a\s+)?[\w\s'-]{0,40}game\s?pass|game\s?pass\s+(?:required|only)|需要\s*game\s?pass/i,
    build: () => ({ type: 'gamepass', label: '需拥有 Game Pass', detail: '需要拥有指定 Game Pass' }),
  },
  {
    type: 'playtime',
    re: /(?:play(?:ed|time)|hours?\s+played)\s*(?:for|of|:)?\s*\d+|(?:at\s+least|minimum)\s+\d+\s*(?:hours?|minutes?)\s+(?:of\s+)?play(?:time|ed)?|游玩时长/i,
    build: () => ({ type: 'playtime', label: '需游玩时长', detail: '需要达到指定游玩时长' }),
  },
  {
    type: 'rebirth',
    re: /(?:rebirths?|prestige|rank)\s*(?:level|lvl)?\s*[:#]?\s*\d+|(?:requires?|must\s+be)\s+(?:rebirth|prestige|rank)\s*\d+|转生\s*\d+|重生\s*\d+/i,
    build: () => ({ type: 'rebirth', label: '需转生/阶级', detail: '需要达到指定转生或阶级等级' }),
  },
  {
    type: 'quest',
    re: /(?:complete|finish|beat)\s+(?:the\s+)?[\w\s'-]{0,40}quest|quest\s+(?:required|only)|完成任务/i,
    build: () => ({ type: 'quest', label: '需完成任务', detail: '需要先完成指定任务' }),
  },
  {
    type: 'account_age',
    re: /account\s+(?:age|created|older)|(?:at\s+least|minimum)\s+\d+\s+days?\s+old|账号(?:年龄|注册)/i,
    build: () => ({ type: 'account_age', label: '需账号条件', detail: '对账号注册时间有要求' }),
  },
  {
    type: 'membership',
    re: /(?:premium|vip|membership|paid\s+membership)\s+(?:required|only|members?)|(?:requires?|must\s+be)\s+(?:a\s+)?(?:premium|vip|member)|需要(?:会员|vip)|会员专属/i,
    build: () => ({ type: 'membership', label: '需会员/VIP', detail: '需要 Premium、VIP 或会员身份' }),
  },
  {
    type: 'purchase',
    re: /(?:must|need|require[sd]?)\s+(?:to\s+)?(?:buy|purchase|spend|pay)|(?:buy|purchase|spend)\s+(?:robux|gems|coins)\s+(?:to|in\s+order\s+to)|(?:requires?|only)\s+(?:robux|purchase)|需要(?:购买|付费|消费)/i,
    build: () => ({ type: 'purchase', label: '需购买/消费', detail: '需要购买或消费游戏内货币' }),
  },
  {
    type: 'limited',
    re: /(?:first|only)\s+\d+\s+(?:players?|users?|people)|limited\s+(?:to|for)|while\s+(?:supplies|stocks?)\s+last|one\s+(?:code\s+)?per\s+(?:account|player|person)|new\s+(?:players?|accounts?)\s+only|限量|仅限(?:新玩家|前\s*\d+)/i,
    build: () => ({ type: 'limited', label: '限量/限时', detail: '存在人数、时间或新账号限制' }),
  },
  {
    type: 'region',
    re: /(?:region|country|server)\s+(?:locked|restricted|only)|only\s+(?:in|for)\s+(?:the\s+)?(?:us|eu|asia|europe|specific\s+region)|锁区|仅限(?:特定)?地区/i,
    build: () => ({ type: 'region', label: '限地区/服务器', detail: '仅限特定地区或服务器' }),
  },
];

const GENERIC_REQUIREMENT =
  /(?:\bmust\b|\brequired?\b|\bneed(?:s|ed)?\b|\bonly\s+(?:if|for|when)\b|\brequires?\s+(?:that|you)\b|需要|必须|仅限)/i;

function splitSentences(text) {
  const normalized = cleanText(text).replace(
    /([.!?。！？])(?=[A-Z“"'(])/g,
    '$1 '
  );
  return normalized
    .split(/(?<=[.!?。！？])\s+|\s*[•·]\s*/)
    .map((part) => cleanText(part))
    .filter(Boolean);
}

function extractRequirements(text) {
  const raw = cleanText(text);
  if (!raw) return [];

  const found = [];
  const seen = new Set();
  const add = (item) => {
    const key = `${item.type}:${item.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(item);
  };

  for (const pattern of REQUIREMENT_PATTERNS) {
    const match = raw.match(pattern.re);
    if (match) add(pattern.build(match));
  }

  // Keep one generic "other requirement" note when nothing above matched but
  // the sentence clearly reads like a condition rather than a reward.
  if (found.length === 0 && GENERIC_REQUIREMENT.test(raw)) {
    const sentence =
      splitSentences(raw).find((part) => GENERIC_REQUIREMENT.test(part)) || raw;
    add({
      type: 'other',
      label: '需满足条件',
      detail: cleanText(sentence).slice(0, 220),
    });
  }

  return found;
}

function isRequirementSentence(sentence) {
  return (
    REQUIREMENT_PATTERNS.some((pattern) => pattern.re.test(sentence)) ||
    (GENERIC_REQUIREMENT.test(sentence) &&
      /\b(?:level|group|discord|follow|subscribe|game\s?pass|quest|rebirth|account|region)\b/i.test(
        sentence
      ))
  );
}

/**
 * Remove requirement sentences from reward text so the UI can show a clean
 * reward and a separate "使用条件" block.
 */
function cleanReward(text, requirements = []) {
  let raw = cleanText(text)
    .replace(/^this code (?:credits|gives|grants) (?:your account )?(?:with )?/i, '')
    .replace(/^redeem (?:this )?code (?:for|to get)\s*/i, '')
    .trim();

  const sentences = splitSentences(raw);
  const kept = sentences.filter((sentence) => !isRequirementSentence(sentence));
  raw = kept.join(' ').trim();

  // If requirement sentences were glued to the reward without a space, keep
  // everything before the first requirement sentence.
  if (!raw && sentences.length > 1) {
    const firstRequirement = sentences.findIndex(isRequirementSentence);
    if (firstRequirement > 0) {
      raw = sentences.slice(0, firstRequirement).join(' ').trim();
    }
  }

  if (!raw && requirements.length) return '';
  return raw.replace(/^[\s:;,.\-–—]+|[\s:;,.\-–—]+$/g, '').slice(0, 500);
}

module.exports = {
  extractRequirements,
  cleanReward,
  isRequirementSentence,
};
