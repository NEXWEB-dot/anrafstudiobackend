export async function analytics(env) {
  if (!env.CLOUDFLARE_ZONE_ID || !env.CLOUDFLARE_ANALYTICS_TOKEN) return {available:false, message:'Visitor analytics is not connected. Configure the Cloudflare zone and analytics token on the private server.'};
  const end = new Date().toISOString().slice(0,10);
  const start = new Date(Date.now() - 7 * 86400000).toISOString().slice(0,10);
  const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method:'POST', signal:AbortSignal.timeout(10000),
    headers:{Authorization:`Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`, 'Content-Type':'application/json'},
    body:JSON.stringify({query:`query Traffic($zone: string, $start: Date, $end: Date) { viewer { zones(filter: {zoneTag: $zone}) { httpRequests1dGroups(limit: 7, orderBy: [date_ASC], filter: {date_geq: $start, date_lt: $end}) { dimensions { date } uniq { uniques } sum { pageViews requests } } } } }`, variables:{zone:env.CLOUDFLARE_ZONE_ID, start, end}}),
  });
  if (!response.ok) throw new Error('Cloudflare analytics is unavailable. Check token permissions and zone access.');
  const result = await response.json();
  const days = result.data?.viewer?.zones?.[0]?.httpRequests1dGroups;
  if (result.errors?.length || !Array.isArray(days)) throw new Error('Cloudflare did not provide analytics. Check permissions and plan availability.');
  return {available:true, start, end, days:days.map(d => ({date:d.dimensions.date, visitors:d.uniq.uniques, pageViews:d.sum.pageViews, requests:d.sum.requests})),
    message:'Last 7 complete UTC days, across the configured Cloudflare zone. Visitors are unique IP estimates per day, may include bots, and are not registered users. Daily visitors are not added together.'};
}
