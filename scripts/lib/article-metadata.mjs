import { sourceUrl } from "../../assets/reader-core.js";
export const CONTENT_VERSION = 2;
const plain = (value) =>
  String(value || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*(?:>\s+|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/(\*\*|__)([\s\S]*?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
export function collectSources(msg = {}) {
  const urls = [
    ...(msg.embeds || []).map((e) => e.url),
    ...(msg.content || "").matchAll(/https?:\/\/[^\s<>]+/g),
  ].map((v) => (Array.isArray(v) ? v[0] : v));
  return [
    ...new Set(
      urls
        .map((value) => {
          let text = String(value || "").replace(/[、。，．！？.!?,;:]+$/g, "");
          while (
            text.endsWith(")") &&
            (text.match(/\)/g) || []).length > (text.match(/\(/g) || []).length
          )
            text = text.slice(0, -1);
          text = text.replace(/[\]】」』]+$/g, "");
          const url = sourceUrl(text);
          if (!url) return null;
          return /(^|\.)(discord\.com|discordapp\.com|discord\.gg)$/.test(
            new URL(url).hostname,
          )
            ? null
            : url;
        })
        .filter(Boolean),
    ),
  ];
}
/** Extract brief quotations from the already edited Discord article; never invent missing sections. */
export function articleMetadata(msg = {}) {
  const source_urls = collectSources(msg);
  const parts = String(msg.content || "")
    .replace(/\r\n/g, "\n")
    .replace(/^\*\*(参考文献|出典)\*\*\s*$/gm, "## $1")
    .split(/\n(?=#{1,3}\s)/);
  const sections = parts
    .map((part) => {
      const match = part.match(/^#{1,3}\s+([^\n]+)\n([\s\S]*)/);
      return match ? { heading: plain(match[1]), text: plain(match[2]) } : null;
    })
    .filter((s) => s && s.text && !/参考文献|出典/.test(s.heading));
  const shorten = (s) => {
    if (s.length <= 350) return s;
    const cut = s.slice(0, 349), end = cut.lastIndexOf("。");
    return (end >= 100 ? cut.slice(0, end + 1) : cut) + "…";
  };
  const caution = sections.find((s) => /留意|注意|制約|限界/.test(s.heading));
  const audience = sections.find((s) =>
    /対象ユーザー|誰に|対象者/.test(s.heading),
  );
  const facts = sections
    .filter(
      (s) =>
        s !== caution && s !== audience && !/今後|展望|まとめ/.test(s.heading),
    )
    .slice(0, 3)
    .map((s) => ({ heading: s.heading, text: shorten(s.text) }));
  return {
    content_version: CONTENT_VERSION,
    source_urls,
    source_url: source_urls[0] || null,
    source_label: source_urls[0]
      ? new URL(source_urls[0]).hostname.replace(/^www\./, "")
      : null,
    summary_sections: facts,
    caution: caution ? shorten(caution.text) : null,
    audience: audience ? shorten(audience.text) : null,
    updated_at: msg.edited_timestamp || null,
  };
}
