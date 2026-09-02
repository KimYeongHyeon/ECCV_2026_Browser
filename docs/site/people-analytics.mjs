const AUTHOR_SEPARATORS = /\s*(?:⋅|,|;|\band\b)\s*/iu;

function normalizedWorkKey(record) {
  const title = String(record.title || "")
    .toLocaleLowerCase()
    .replace(/\\[a-z]+\b/giu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return title || String(record.id || "");
}

function sortedCounts(counts, limit = 5) {
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => (right.count - left.count) || left.label.localeCompare(right.label))
    .slice(0, limit);
}

function addTopics(counts, record) {
  const labels = coreTopicTags(record);
  for (const label of new Set(labels.filter(Boolean))) {
    counts.set(label, (counts.get(label) || 0) + 1);
  }
}

function normalizedName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function parseAuthors(value) {
  return [...new Set(String(value || "")
    .split(AUTHOR_SEPARATORS)
    .map((name) => name.replace(/\s+/g, " ").trim())
    .filter(Boolean))];
}

export function buildPeopleAnalytics(records) {
  const worksByKey = new Map();
  for (const record of records || []) {
    if (!record?.title || !record?.authors) continue;
    const key = normalizedWorkKey(record);
    const previous = worksByKey.get(key);
    if (!previous || (previous.type === "poster" && record.type !== "poster")) {
      worksByKey.set(key, record);
    }
  }
  const works = [...worksByKey.values()]
    .sort((left, right) => normalizedWorkKey(left).localeCompare(normalizedWorkKey(right)))
    .map((record, workIndex) => {
    const names = parseAuthors(record.authors);
    return {
      ...record,
      authorEntries: names.map((name, authorIndex) => ({
        occurrenceId: `${workIndex}:${authorIndex}`,
        name,
        normalizedName: normalizedName(name),
        email: String(record.authorEmails?.[authorIndex] || "").trim().toLocaleLowerCase(),
      })),
    };
  }).filter((record) => record.authorEntries.length);

  const parent = new Map();
  const componentEmails = new Map();
  const root = (id) => {
    const current = parent.get(id) || id;
    if (current === id) return id;
    const resolved = root(current);
    parent.set(id, resolved);
    return resolved;
  };
  const unite = (left, right) => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot === rightRoot) return;
    const leftEmails = componentEmails.get(leftRoot) || new Set();
    const rightEmails = componentEmails.get(rightRoot) || new Set();
    const combinedEmails = new Set([...leftEmails, ...rightEmails]);
    if (combinedEmails.size > 1) return;
    parent.set(rightRoot, leftRoot);
    componentEmails.set(leftRoot, combinedEmails);
    componentEmails.delete(rightRoot);
  };
  const occurrences = works.flatMap((record) => record.authorEntries);
  const workByOccurrence = new Map();
  works.forEach((record) => record.authorEntries.forEach((entry) => workByOccurrence.set(entry.occurrenceId, record)));
  occurrences.forEach((entry) => {
    parent.set(entry.occurrenceId, entry.occurrenceId);
    componentEmails.set(entry.occurrenceId, entry.email ? new Set([entry.email]) : new Set());
  });
  const byEmail = new Map();
  const byName = new Map();
  for (const entry of occurrences) {
    if (entry.email) {
      const emailMatches = byEmail.get(entry.email) || [];
      emailMatches.forEach((match) => unite(entry.occurrenceId, match.occurrenceId));
      emailMatches.push(entry);
      byEmail.set(entry.email, emailMatches);
    }
    const nameMatches = byName.get(entry.normalizedName) || [];
    nameMatches.push(entry);
    byName.set(entry.normalizedName, nameMatches);
  }
  for (const matches of byName.values()) {
    for (let left = 0; left < matches.length; left += 1) {
      const leftWork = workByOccurrence.get(matches[left].occurrenceId);
      const leftContext = new Set(leftWork.authorEntries.map((entry) => (
        entry.email ? `email:${entry.email}` : `name:${entry.normalizedName}`
      )));
      for (let right = left + 1; right < matches.length; right += 1) {
        if (matches[left].email && matches[right].email && matches[left].email !== matches[right].email) continue;
        const rightWork = workByOccurrence.get(matches[right].occurrenceId);
        const sharesCoauthor = rightWork.authorEntries.some((entry) => (
          entry.normalizedName !== matches[right].normalizedName
          && leftContext.has(entry.email ? `email:${entry.email}` : `name:${entry.normalizedName}`)
        ));
        if (sharesCoauthor) unite(matches[left].occurrenceId, matches[right].occurrenceId);
      }
    }
  }

  const authorsById = new Map();
  for (const record of works) {
    for (const entry of record.authorEntries) {
      const identityId = root(entry.occurrenceId);
      const author = authorsById.get(identityId) || {
        identityId,
        names: new Map(),
        email: entry.email,
        paperCount: 0,
        topics: new Map(),
        recordIds: [],
      };
      author.names.set(entry.name, (author.names.get(entry.name) || 0) + 1);
      author.email ||= entry.email;
      author.paperCount += 1;
      author.recordIds.push(record.id);
      addTopics(author.topics, record);
      authorsById.set(identityId, author);
      entry.identityId = identityId;
    }
  }

  const authors = [...authorsById.values()].map((author) => {
    const aliases = [...author.names.keys()].sort();
    const name = [...author.names.entries()]
      .sort((left, right) => (right[1] - left[1]) || (right[0].length - left[0].length))[0][0];
    return {
      identityId: author.identityId,
      name,
      email: author.email,
      aliases,
      paperCount: author.paperCount,
      topics: sortedCounts(author.topics),
      recordIds: author.recordIds,
    };
  }).sort((left, right) => (right.paperCount - left.paperCount) || left.name.localeCompare(right.name));
  const authorById = new Map(authors.map((author) => [author.identityId, author]));

  const pairCounts = new Map();
  for (const record of works) {
    const ids = [...new Set(record.authorEntries.map((entry) => entry.identityId))];
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const pairKey = JSON.stringify([ids[left], ids[right]].sort());
        pairCounts.set(pairKey, (pairCounts.get(pairKey) || 0) + 1);
      }
    }
  }
  const coauthorLinks = [...pairCounts.entries()].map(([pairKey, value]) => {
    const [source, target] = JSON.parse(pairKey);
    return { source, target, value };
  }).sort((left, right) => (right.value - left.value) || left.source.localeCompare(right.source));
  const groupParent = new Map();
  const groupRoot = (id) => {
    const current = groupParent.get(id) || id;
    if (current === id) return id;
    const resolved = groupRoot(current);
    groupParent.set(id, resolved);
    return resolved;
  };
  for (const [pairKey, count] of pairCounts.entries()) {
    if (count < 2) continue;
    const [left, right] = JSON.parse(pairKey);
    const leftRoot = groupRoot(left);
    const rightRoot = groupRoot(right);
    groupParent.set(left, leftRoot);
    groupParent.set(right, rightRoot);
    if (leftRoot !== rightRoot) groupParent.set(rightRoot, leftRoot);
  }
  const membersByRoot = new Map();
  for (const identityId of groupParent.keys()) {
    const id = groupRoot(identityId);
    const members = membersByRoot.get(id) || [];
    members.push(identityId);
    membersByRoot.set(id, members);
  }
  const groups = [...membersByRoot.values()].map((memberIds) => {
    const memberSet = new Set(memberIds);
    const groupWorks = works.filter((record) => record.authorEntries.filter((entry) => memberSet.has(entry.identityId)).length >= 2);
    const topics = new Map();
    groupWorks.forEach((record) => addTopics(topics, record));
    const sortedMemberIds = memberIds.slice().sort((left, right) => {
      const countDelta = (authorById.get(right)?.paperCount || 0) - (authorById.get(left)?.paperCount || 0);
      return countDelta || (authorById.get(left)?.name || left).localeCompare(authorById.get(right)?.name || right);
    });
    const members = sortedMemberIds.map((id) => authorById.get(id)?.name || id);
    return {
      id: memberIds.slice().sort().join("|"),
      members,
      paperCount: groupWorks.length,
      topics: sortedCounts(topics),
      recordIds: groupWorks.map((record) => record.id),
    };
  }).filter((group) => group.paperCount >= 2)
    .sort((left, right) => (right.paperCount - left.paperCount) || (right.members.length - left.members.length));

  return {
    summary: {
      uniqueWorks: works.length,
      authorCount: authors.length,
      groupCount: groups.length,
      emailIdentityCount: authors.filter((author) => author.email).length,
    },
    authors,
    coauthorLinks,
    groups,
  };
}

export function buildAuthorNetworkFromAnalytics(analytics, { minWorks = 2, maxAuthors = 1200 } = {}) {
  const eligibleAuthors = analytics.authors
    .filter((author) => author.paperCount >= minWorks)
    .map((author) => ({
      id: author.identityId,
      title: author.name,
      paperCount: author.paperCount,
      topics: author.topics,
      recordIds: author.recordIds,
      group: author.topics[0]?.label || "Other",
    }));
  const nodes = eligibleAuthors.slice(0, maxAuthors);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const links = analytics.coauthorLinks.filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target));
  const neighborsById = new Map(nodes.map((node) => [node.id, []]));
  for (const link of links) {
    neighborsById.get(link.source)?.push({ id: link.target, workCount: link.value });
    neighborsById.get(link.target)?.push({ id: link.source, workCount: link.value });
  }
  neighborsById.forEach((neighbors) => neighbors.sort((left, right) => right.workCount - left.workCount));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const topicCounts = new Map();
  nodes.forEach((node) => topicCounts.set(node.group, (topicCounts.get(node.group) || 0) + 1));
  const [leadingTopic = "Other", leadingTopicCount = 0] = [...topicCounts.entries()]
    .sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0]))[0] || [];
  const strongestLink = links[0];
  const strongestPair = strongestLink ? {
    source: nodeById.get(strongestLink.source)?.title || strongestLink.source,
    target: nodeById.get(strongestLink.target)?.title || strongestLink.target,
    workCount: strongestLink.value,
  } : null;
  const connector = nodes.map((node) => ({
    id: node.id,
    name: node.title,
    collaboratorCount: (neighborsById.get(node.id) || []).length,
    workCount: node.paperCount,
  })).sort((left, right) => (right.collaboratorCount - left.collaboratorCount) || (right.workCount - left.workCount))[0] || null;
  return {
    summary: {
      minWorks,
      authorCap: maxAuthors,
      authorCount: nodes.length,
      eligibleAuthorCount: eligibleAuthors.length,
      linkCount: links.length,
      uniqueWorks: analytics.summary.uniqueWorks,
    },
    nodes,
    links,
    neighborsById,
    insights: {
      prolificAuthor: nodes[0] ? { id: nodes[0].id, name: nodes[0].title, workCount: nodes[0].paperCount, topic: nodes[0].group } : null,
      strongestPair,
      connector,
      leadingTopic: { label: leadingTopic, authorCount: leadingTopicCount },
    },
  };
}

export function buildAuthorNetwork(records, options = {}) {
  return buildAuthorNetworkFromAnalytics(buildPeopleAnalytics(records), options);
}
import { coreTopicTags } from "./core-topics.mjs";
