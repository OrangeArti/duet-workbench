// Managed regions inside files the user also owns. Insert and remove are exact inverses,
// so `remove` restores a file byte for byte.
// shortcut: a source text containing the literal end marker would cut the region short;
// escape markers if that ever shows up in a real CLAUDE.md.

function markers(style, id) {
  const tag = id ? ` ${id}` : "";
  return style === "md"
    ? [`<!-- duet-workbench:begin${tag} -->`, `<!-- duet-workbench:end${tag} -->`]
    : [`# duet-workbench:begin${tag}`, `# duet-workbench:end${tag}`];
}

function findRegion(text, style, id) {
  const [begin, end] = markers(style, id);
  const start = text.startsWith(`${begin}\n`) ? 0 : text.indexOf(`\n${begin}\n`) + 1 || -1;
  if (start < 0) {
    return null;
  }
  const bodyStart = start + begin.length + 1;
  const endAt = text.indexOf(`\n${end}`, bodyStart - 1);
  if (endAt < 0) {
    return null;
  }
  let stop = endAt + 1 + end.length;
  if (text[stop] === "\n") {
    stop += 1;
  }
  return { start, stop, body: text.slice(bodyStart, Math.max(bodyStart, endAt)) };
}

export function getRegion(text, style, id = "") {
  return findRegion(text, style, id)?.body ?? null;
}

export function removeRegion(text, style, id = "", position = "end") {
  const region = findRegion(text, style, id);
  if (!region) {
    return text;
  }
  let before = text.slice(0, region.start);
  let after = text.slice(region.stop);
  if (position === "top") {
    after = after.startsWith("\n") ? after.slice(1) : after;
  } else {
    before = before.endsWith("\n") ? before.slice(0, -1) : before;
  }
  return before + after;
}

export function setRegion(text, style, id, body, position = "end") {
  if (body == null) {
    return removeRegion(text, style, id, position);
  }
  const [begin, end] = markers(style, id);
  const block = `${begin}\n${body}\n${end}\n`;
  const region = findRegion(text, style, id);
  if (region) {
    return text.slice(0, region.start) + block + text.slice(region.stop);
  }
  if (position === "top") {
    return block + (text ? `\n${text}` : "");
  }
  return (text ? `${text}\n` : "") + block;
}
