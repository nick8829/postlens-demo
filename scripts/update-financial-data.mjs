import fs from 'node:fs/promises';
async function fetchFinancialHeadlines(options) {
  const feeds = [
    { url: 'https://api-one.wallstcn.com/apiv1/content/articles/hot?period=all', kind: '热门文章' },
    { url: 'https://api-one.wallstcn.com/apiv1/content/information-flow?channel=global-channel&accept=article&limit=100', kind: '近期资讯' },
  ];
  const results = await Promise.allSettled(feeds.map(async (feed) => {
    const response = await globalThis.fetch(feed.url, options);
    if (!response.ok) throw Error('财经来源暂时不可用');
    const payload = await response.json();
    const records = feed.kind === '热门文章'
      ? [...(payload.data?.day_items || []).map(row => ({...row, listKind: '当日热门'})),
         ...(payload.data?.week_items || []).map(row => ({...row, listKind: '近7天热门'}))]
      : payload.data?.items?.filter(item => item.resource_type !== 'ad' && item.resource_type !== 'theme').map(item => item.resource);
    if (!Array.isArray(records)) throw Error('财经数据格式不可用');
    return records.filter(row => row && row.type !== 'live').map((row, index) => ({
      title: row.title,
      url: row.uri,
      kind: row.listKind || feed.kind,
      rank: index + 1,
      pubDate: row.display_time ? row.display_time * 1000 : undefined,
      timeKind: 'retrieved',
      provider: '华尔街见闻公开接口',
    }));
  }));
  const items = new Map();
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const row of result.value) {
      if (row.url && !items.has(row.url)) items.set(row.url, row);
    }
  }
  if (!items.size) return Response.json({ error: '财经来源暂时无法读取' }, { status: 503 });
  return Response.json({ status: 'success', updatedTime: Date.now(), items: [...items.values()] });
}

const response = await fetchFinancialHeadlines({signal: AbortSignal.timeout(15000)});
if (!response.ok) throw Error('No financial feed returned data. Previous snapshot preserved.');
const snapshot = await response.json();
await fs.mkdir('data', {recursive: true});
await fs.writeFile('data/financial-news.json', JSON.stringify(snapshot));
console.log('Saved', snapshot.items.length, 'financial headlines at', new Date(snapshot.updatedTime).toISOString());
