import fs from 'node:fs/promises';
async function fetchCryptoHeadlines(options) {
  const endpoints = ['https://cointelegraph.com/rss','https://cointelegraph.com/rss/tag/bitcoin','https://cointelegraph.com/rss/tag/stablecoin','https://cointelegraph.com/rss/tag/defi'];
  const results = await Promise.allSettled(endpoints.map(async endpoint => {
    const response = await globalThis.fetch(endpoint, options);
    if (!response.ok) throw Error('Crypto feed unavailable');
    const xml = await response.text();
    const decode = value => value.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>');
    const tag = (item,name) => decode(item.match(new RegExp('<'+name+'[^>]*>([\\s\\S]*?)</'+name+'>','i'))?.[1]?.trim() || '');
    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)].map((match,index) => {
      const item=match[1];return {title:tag(item,'title'),url:tag(item,'link'),pubDate:Date.parse(tag(item,'pubDate')),rank:index+1,kind:'近7天加密资讯（英文）',timeKind:'retrieved',provider:'Cointelegraph RSS'};
    }).filter(item => item.title && item.url.startsWith('https://cointelegraph.com/') && Number.isFinite(item.pubDate));
    if(!items.length)throw Error('Empty crypto feed');
    return items;
  }));
  const unique = new Map();
  for (const result of results) if (result.status === 'fulfilled') for (const item of result.value) {
    const canonical = new URL(item.url);canonical.search='';canonical.hash='';item.url=canonical.href;
    if (Date.now()-item.pubDate < 7*86400000 && item.pubDate < Date.now()+300000) unique.set(item.url,item);
  }
  const items=[...unique.values()].sort((a,b)=>b.pubDate-a.pubDate).map((row,index)=>({...row,rank:index+1}));
  if(!items.length)return Response.json({error:'加密资讯暂时无法读取'},{status:503});
  return Response.json({status:'success',updatedTime:Date.now(),items});
}

const communityHotspotBase = 'https://60s.zellon.top/v2/';
const communityHotspotRoutes = {
  weibo: 'weibo',
  zhihu: 'zhihu',
  baidu: 'baidu/hot',
  douyin: 'douyin',
  'bilibili-hot-search': 'bili',
  ithome: 'it-news',
};

let sourceSnapshotTask;
function resetRadarSources() { sourceSnapshotTask = undefined; }
async function loadSourceSnapshot() {
  if (!sourceSnapshotTask) sourceSnapshotTask = (async () => {
    try {
      const endpoint = new URL('./data/hotspot-sources.json', location.href || 'https://nick8829.github.io/postlens-demo/');
      const response = await globalThis.fetch(endpoint.href, {cache:'no-cache',credentials:'omit',signal:AbortSignal.timeout(5000)});
      if (response.ok) { const bundle=await response.json(); if (bundle.feeds) return bundle; }
    } catch {}
    return packagedSourceSnapshot;
  })();
  return sourceSnapshotTask;
}
async function fetchHotspotSource(sourceId, options) {
  const bundle = await loadSourceSnapshot();
  const snapshot = bundle?.feeds?.[sourceId];
  if (usableFinancialSnapshot(snapshot)) return Response.json(snapshot);
  if (bundle?.errors?.[sourceId] && Date.now()-bundle.updatedTime<2*3600000) {
    return Response.json({error:'后台本次未能读取此来源'},{status:503});
  }
  try {
    const direct = await fetchHotspotSourceDirect(sourceId, options);
    if (direct.ok) return direct;
  } catch {}
  if (sourceId === 'cointelegraph') return readFinancialSnapshot('crypto-news.json', packagedCryptoSnapshot);
  if (sourceId === 'wallstreetcn-hot') return readFinancialSnapshot();
  return Response.json({error:'本次来源不可用，未计入查询范围'},{status:503});
}

async function fetchHotspotSourceDirect(sourceId, options) {
  if (sourceId === 'cointelegraph') {
    return fetchCryptoHeadlines(options);
  }
  if (sourceId === 'wallstreetcn-hot') {
    return fetchFinancialHeadlines(options);
  }
  let endpoint;
  if (communityHotspotRoutes[sourceId]) {
    endpoint = communityHotspotBase + communityHotspotRoutes[sourceId];
  } else {
    return globalThis.fetch(
      'https://newsnow.busiyi.world/api/s?id=' + encodeURIComponent(sourceId),
      options,
    );
  }

  const response = await globalThis.fetch(endpoint, options);
  if (!response.ok) return response;
  const payload = await response.json();
  const rows = payload.code === 200 ? payload.data : null;
  if (!Array.isArray(rows)) {
    return Response.json({ error: '热点来源未返回有效榜单' }, { status: 503 });
  }

  // These providers do not expose a board update time. Label this as read time.
  const retrievedAt = Date.now();
  const items = rows.map((row) => ({
    title: row.title,
    url: row.link || row.url || row.uri,
    pubDate: sourceId === 'ithome' ? row.created_at : undefined,
    extra: { info: String(row.hot_value_desc || row.score_desc || row.hot_value || '') },
    timeKind: 'retrieved',
    provider: '60s API 公共实例',
  }));
  return Response.json({ status: 'success', updatedTime: retrievedAt, items });
}

async function readFinancialSnapshot(filename = 'financial-news.json', packaged = packagedFinancialSnapshot) {
  const endpoints = [
    new URL('./data/'+filename, location.href || 'https://nick8829.github.io/postlens-demo/').href,
    'https://raw.githubusercontent.com/nick8829/postlens-demo/main/data/'+filename,
  ];
  for (const endpoint of endpoints) {
  try {
    const response = await globalThis.fetch(
      endpoint,
      { credentials: 'omit', cache: 'no-cache', signal: AbortSignal.timeout(4000) },
    );
    if (response.ok) {
      const snapshot = await response.json();
      if (usableFinancialSnapshot(snapshot)) return Response.json(snapshot);
    }
  } catch {
    // A packaged snapshot keeps a recent successful fetch available during outages.
  }
  }
  if (usableFinancialSnapshot(packaged)) {
    return Response.json(packaged);
  }
  return Response.json({ error: '财经接口与备用数据暂时不可用' }, { status: 503 });
}

function usableFinancialSnapshot(snapshot) {
  const age = Date.now() - Number(snapshot?.updatedTime);
  return Array.isArray(snapshot?.items) && snapshot.items.length > 0
    && Number.isFinite(age) && age >= -300000 && age < 86400000;
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

await fs.mkdir('data', {recursive:true});
let prior={feeds:{}};
try {prior=JSON.parse(await fs.readFile('data/hotspot-sources.json','utf8'));} catch {}
const ids=['weibo','zhihu','baidu','douyin','bilibili-hot-search','wallstreetcn-hot','cls-hot','ithome','cointelegraph'];
const feeds={...prior.feeds}, errors={};
let saved=0;
await Promise.all(ids.map(async id=>{
  try {
    const response=await fetchHotspotSourceDirect(id,{signal:AbortSignal.timeout(18000)});
    if(!response.ok)throw Error('HTTP '+response.status);
    let snapshot=await response.json();
    if(!usableFinancialSnapshot(snapshot))throw Error('Invalid or empty snapshot');
    if(id==='cointelegraph') {
      const articles=new Map();
      for(const item of [...(prior.feeds?.[id]?.items||[]),...snapshot.items]){
        const canonical=new URL(item.url);canonical.search='';canonical.hash='';item.url=canonical.href;
        if(Number.isFinite(item.pubDate)&&Date.now()-item.pubDate<7*86400000&&item.pubDate<Date.now()+300000)articles.set(item.url,item);
      }
      snapshot.items=[...articles.values()].sort((a,b)=>b.pubDate-a.pubDate).slice(0,600).map((row,index)=>({...row,rank:index+1}));
    }
    feeds[id]=snapshot;saved++;
    const file=id==='cointelegraph'?'crypto-news.json':id==='wallstreetcn-hot'?'financial-news.json':null;
    if(file)await fs.writeFile('data/'+file,JSON.stringify(snapshot));
    console.log(id,snapshot.items.length,'items');
  } catch(error){errors[id]=error.message;console.error(id+': '+error.message+'; previous successful snapshot retained');}
}));
const bundle={updatedTime:Date.now(),feeds,errors};
await fs.writeFile('data/hotspot-sources.json',JSON.stringify(bundle));
if(!saved)throw Error('No source refreshed. Existing per-source timestamps were preserved.');
console.log('Refreshed',saved,'of',ids.length,'sources');
