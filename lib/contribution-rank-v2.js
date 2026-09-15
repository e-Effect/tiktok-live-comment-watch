export const RANK_POLICY = '90d-comments10-coins100-linear-v2';
export function contributionTier(position,total){
 if(!(position>0&&total>0))return 'ランクなし';
 for(const [tier,fraction] of [['S',.005],['A',.02],['B',.06],['C',.10]]){
  if(position<=Math.max(1,Math.ceil(total*fraction)))return tier;
 }
 return 'D';
}
export function noContributionRank(ready=false){
 const rank=ready?'ランクなし':'未計算';
 return {contributionRank:rank,contributionScore:0,contributionPosition:null,contributionTotal:0,
   contributionCoins:0,contributionCoinsPerVisit:0,contributionComments:0,contributionVisits:0,
   recentContributionRank:rank,recentContributionScore:0,recentContributionPosition:null,recentContributionTotal:0,
   recentContributionCoins:0,recentContributionCoinsPerVisit:0,rankPolicy:RANK_POLICY};
}
const num=v=>Number.isFinite(Number(v))?Math.max(0,Number(v)):0;
export function buildContributionRankings(rows=[]){
 const prepared=rows.map(r=>({userId:String(r.user_id||r.userId||''),searchText:String(r.search_text||r.searchText||'').normalize('NFKC').toLocaleLowerCase('ja-JP'),
   coins:num(r.recent_coins??r.coins),comments:num(r.recent_comments??r.comments),likes:num(r.recent_likes??r.likes),visits:num(r.recent_visits??r.visits)})).filter(r=>r.userId);
 const eligible=prepared.filter(r=>r.comments>=10&&r.coins>=100);
 const max=Object.fromEntries(['coins','comments','likes','visits'].map(k=>[k,eligible.reduce((m,r)=>Math.max(m,r[k]),1)]));
 for(const r of eligible){
  const G=r.coins/max.coins,C=r.comments/max.comments,L=r.likes/max.likes,V=r.visits/max.visits;
  r.parts={gift:40*G,comment:30*C,like:10*L,visit:5*V,participation:15*V*(.5*G+.3*C+.2*L)};
  r.score=Object.values(r.parts).reduce((a,b)=>a+b,0);
 }
 eligible.sort((a,b)=>b.score-a.score||b.coins-a.coins||b.comments-a.comments||a.userId.localeCompare(b.userId));
 const byUserId=new Map(prepared.map(r=>[r.userId,{...noContributionRank(true),userId:r.userId,searchText:r.searchText}]));
 eligible.forEach((r,i)=>{
  const score=Math.round(r.score*10)/10,rank=contributionTier(i+1,eligible.length),perVisit=Math.round(r.coins/Math.max(1,r.visits)*10)/10;
  byUserId.set(r.userId,{userId:r.userId,searchText:r.searchText,rankPolicy:RANK_POLICY,
    contributionScore:score,contributionRank:rank,contributionPosition:i+1,contributionTotal:eligible.length,
    contributionCoins:r.coins,contributionCoinsPerVisit:perVisit,contributionComments:r.comments,contributionVisits:r.visits,contributionParts:r.parts,
    recentContributionScore:score,recentContributionRank:rank,recentContributionPosition:i+1,recentContributionTotal:eligible.length,
    recentContributionCoins:r.coins,recentContributionCoinsPerVisit:perVisit});
 });
 const order=eligible.map(r=>r.userId);
 return {byUserId,lifetimeOrder:order,recentOrder:order,policy:RANK_POLICY};
}
