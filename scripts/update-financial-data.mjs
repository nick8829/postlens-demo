import fs from 'node:fs/promises';
async function fetchCryptoHeadlines(options) {
  try {
    const response = await globalThis.fetch('https://cointelegraph.com/rss', options);
    if (!response.ok) throw Error('Crypto feed unavailable');
    const xml = await response.text();
    const decode = value => value.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const tag = (item,name) => decode(item.match(new RegExp('<'+name+'[^>]*>([\\s\\S]*?)</'+name+'>','i'))?.[1]?.trim() || '');
    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map((match,index) => {
      const item=match[1];return {title:tag(item,'title'),url:tag(item,'link'),pubDate:Date.parse(tag(item,'pubDate')),rank:index+1,kind:'近期加密资讯（英文）',timeKind:'retrieved',provider:'Cointelegraph RSS'};
    }).filter(item => item.title && item.url.startsWith('https://cointelegraph.com/') && Number.isFinite(item.pubDate));
    if(!items.length)throw Error('Empty crypto feed');
    return Response.json({status:'success',updatedTime:Date.now(),items});
  } catch { return Response.json({error:'加密资讯暂时无法读取'},{status:503}); }
}

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

await fs.mkdir('data', {recursive: true});
let saved=0;
await Promise.all([['financial-news.json',fetchFinancialHeadlines],['crypto-news.json',fetchCryptoHeadlines]].map(async ([filename,load])=>{
 const response=await load({signal:AbortSignal.timeout(15000)});
 if(!response.ok){console.error(filename+': feed unavailable; previous snapshot preserved');return;}
 const snapshot=await response.json();await fs.writeFile('data/'+filename,JSON.stringify(snapshot));saved++;
 console.log('Saved',snapshot.items.length,filename,'at',new Date(snapshot.updatedTime).toISOString());
}));
if(!saved)throw Error('All feeds unavailable. Previous snapshots preserved.');
