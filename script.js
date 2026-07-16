/* =========================================================================
   Signal Scanner Pro — script.js
   Pure vanilla JS. No backend. Reads live OHLC data from Binance's public
   REST API and computes a multi-indicator technical signal client-side.
   ========================================================================= */

/* ---------- Config ---------- */
const BINANCE_MIRRORS = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://data-api.binance.vision'
];
const FETCH_TIMEOUT_MS = 8000;

const QUICK_SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT',
  'LINKUSDT','SUIUSDT','PEPEUSDT','TRXUSDT','AVAXUSDT','APTUSDT','ARBUSDT',
  'OPUSDT','INJUSDT','FETUSDT','VANRYUSDT','1000PEPEUSDT'
];

/* Normalizes whatever the person types into a valid-looking Binance symbol:
   trims spaces, removes slashes/dashes, uppercases, and appends USDT if
   no recognized quote asset suffix was typed (e.g. "epic" -> "EPICUSDT"). */
function normalizeSymbol(raw){
  let s = (raw||'').trim().toUpperCase().replace(/[\s\/\-_]/g,'');
  if(!s) return '';
  const knownQuotes = ['USDT','FDUSD','USDC','BUSD','BTC','ETH','BNB','TRY','EUR'];
  const hasQuote = knownQuotes.some(q=> s.length>q.length && s.endsWith(q));
  if(!hasQuote) s = s + 'USDT';
  return s;
}

/* ---------- State ---------- */
let autoTimer = null;
let historyList = []; // in-memory only (session), max 100
let notifEnabled = false;
let priceSeriesChart = null, candleSeries = null, ema20Series = null, ema50Series = null, ema200Series = null;

/* =========================================================================
   INDICATOR MATH
   ========================================================================= */
function sma(values, period){
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for(let i=0;i<values.length;i++){
    sum += values[i];
    if(i>=period) sum -= values[i-period];
    if(i>=period-1) out[i] = sum/period;
  }
  return out;
}

function ema(values, period){
  const out = new Array(values.length).fill(null);
  const k = 2/(period+1);
  let prev = null;
  for(let i=0;i<values.length;i++){
    if(i===period-1){ prev = values.slice(0,period).reduce((a,b)=>a+b,0)/period; out[i]=prev; }
    else if(i>=period){ prev = values[i]*k + prev*(1-k); out[i]=prev; }
  }
  return out;
}

function rsi(values, period){
  const out = new Array(values.length).fill(null);
  let gains=0, losses=0;
  for(let i=1;i<values.length;i++){
    const diff = values[i]-values[i-1];
    const gain = diff>0?diff:0, loss = diff<0?-diff:0;
    if(i<=period){
      gains+=gain; losses+=loss;
      if(i===period){ const rs = losses===0?100:gains/losses; out[i] = losses===0?100:100-(100/(1+rs)); }
    } else {
      gains = (gains*(period-1)+gain)/period;
      losses = (losses*(period-1)+loss)/period;
      const rs = losses===0?100:gains/losses;
      out[i] = losses===0?100:100-(100/(1+rs));
    }
  }
  return out;
}

function macd(values, fast=12, slow=26, signalP=9){
  const emaFast = ema(values, fast), emaSlow = ema(values, slow);
  const line = values.map((_,i)=> (emaFast[i]!=null && emaSlow[i]!=null)? emaFast[i]-emaSlow[i] : null);
  const valsOnly=[], idxMap=[];
  line.forEach((v,i)=>{ if(v!=null){ valsOnly.push(v); idxMap.push(i);} });
  const sigOnly = ema(valsOnly, signalP);
  const signal = new Array(values.length).fill(null);
  sigOnly.forEach((v,i)=>{ if(v!=null) signal[idxMap[i]]=v; });
  const hist = values.map((_,i)=> (line[i]!=null && signal[i]!=null)? line[i]-signal[i] : null);
  return {line, signal, hist};
}

function trueRange(highs, lows, closes){
  const tr = new Array(highs.length).fill(null);
  for(let i=0;i<highs.length;i++){
    if(i===0){ tr[i] = highs[i]-lows[i]; continue; }
    tr[i] = Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1]));
  }
  return tr;
}

function atr(highs, lows, closes, period=14){
  const tr = trueRange(highs, lows, closes);
  const out = new Array(tr.length).fill(null);
  let prev=null;
  for(let i=0;i<tr.length;i++){
    if(i===period-1){ prev = tr.slice(0,period).reduce((a,b)=>a+b,0)/period; out[i]=prev; }
    else if(i>=period){ prev = (prev*(period-1)+tr[i])/period; out[i]=prev; }
  }
  return out;
}

function adx(highs, lows, closes, period=14){
  const n = highs.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0);
  for(let i=1;i<n;i++){
    const upMove = highs[i]-highs[i-1];
    const downMove = lows[i-1]-lows[i];
    plusDM[i] = (upMove>downMove && upMove>0) ? upMove : 0;
    minusDM[i] = (downMove>upMove && downMove>0) ? downMove : 0;
  }
  const tr = trueRange(highs, lows, closes);
  function wilderSmooth(arr){
    const out = new Array(arr.length).fill(null);
    let prev=null;
    for(let i=0;i<arr.length;i++){
      if(i===period){ prev = arr.slice(1,period+1).reduce((a,b)=>a+b,0); out[i]=prev; }
      else if(i>period){ prev = prev - (prev/period) + arr[i]; out[i]=prev; }
    }
    return out;
  }
  const smTR = wilderSmooth(tr), smPlus = wilderSmooth(plusDM), smMinus = wilderSmooth(minusDM);
  const plusDI = new Array(n).fill(null), minusDI = new Array(n).fill(null), dx = new Array(n).fill(null);
  for(let i=0;i<n;i++){
    if(smTR[i]){
      plusDI[i] = 100*(smPlus[i]/smTR[i]);
      minusDI[i] = 100*(smMinus[i]/smTR[i]);
      const sum = plusDI[i]+minusDI[i];
      dx[i] = sum? 100*Math.abs(plusDI[i]-minusDI[i])/sum : 0;
    }
  }
  const out = new Array(n).fill(null);
  let prevAdx=null, count=0, seed=0;
  for(let i=0;i<n;i++){
    if(dx[i]!=null){
      count++;
      if(count<=period){ seed+=dx[i]; if(count===period){ prevAdx = seed/period; out[i]=prevAdx; } }
      else { prevAdx = (prevAdx*(period-1)+dx[i])/period; out[i]=prevAdx; }
    }
  }
  return {adx: out, plusDI, minusDI};
}

function supertrend(highs, lows, closes, atrArr, period=10, multiplier=3){
  const n = highs.length;
  const st = new Array(n).fill(null);
  const dir = new Array(n).fill(null); // 1 = uptrend, -1 = downtrend
  let finalUpper=null, finalLower=null;
  for(let i=0;i<n;i++){
    if(atrArr[i]==null){ continue; }
    const mid = (highs[i]+lows[i])/2;
    const basicUpper = mid + multiplier*atrArr[i];
    const basicLower = mid - multiplier*atrArr[i];
    if(finalUpper===null){ finalUpper = basicUpper; finalLower = basicLower; dir[i]=1; st[i]=finalLower; continue; }
    finalUpper = (basicUpper < finalUpper || closes[i-1] > finalUpper) ? basicUpper : finalUpper;
    finalLower = (basicLower > finalLower || closes[i-1] < finalLower) ? basicLower : finalLower;
    const prevDir = dir[i-1] || 1;
    let curDir;
    if(prevDir===1){ curDir = closes[i] < finalLower ? -1 : 1; }
    else { curDir = closes[i] > finalUpper ? 1 : -1; }
    dir[i] = curDir;
    st[i] = curDir===1 ? finalLower : finalUpper;
  }
  return {st, dir};
}

function vwap(highs, lows, closes, volumes){
  const n = highs.length;
  const out = new Array(n).fill(null);
  let cumPV=0, cumV=0;
  for(let i=0;i<n;i++){
    const tp = (highs[i]+lows[i]+closes[i])/3;
    cumPV += tp*(volumes[i]||0);
    cumV += (volumes[i]||0);
    out[i] = cumV? cumPV/cumV : null;
  }
  return out;
}

function detectCandlePattern(rows, i){
  if(i<1) return null;
  const c = rows[i], p = rows[i-1];
  const body = Math.abs(c.close-c.open), range = c.high-c.low || 1e-9;
  if(body <= 0.1*range) return 'doji';
  const prevBearish = p.close < p.open, prevBullish = p.close > p.open;
  const curBullish = c.close > c.open, curBearish = c.close < c.open;
  if(prevBearish && curBullish && c.open<=p.close && c.close>=p.open) return 'bullish_engulfing';
  if(prevBullish && curBearish && c.open>=p.close && c.close<=p.open) return 'bearish_engulfing';
  return null;
}

/* =========================================================================
   SIGNAL ENGINE
   ========================================================================= */
function computeFullAnalysis(rows){
  const closes = rows.map(r=>r.close), highs = rows.map(r=>r.high), lows = rows.map(r=>r.low), vols = rows.map(r=>r.volume);
  const n = closes.length;

  const ema20 = ema(closes,20), ema50 = ema(closes,50), ema200 = ema(closes,200);
  const rsi14 = rsi(closes,14);
  const {hist: macdHist} = macd(closes,12,26,9);
  const atr14 = atr(highs,lows,closes,14);
  const {adx: adx14, plusDI, minusDI} = adx(highs,lows,closes,14);
  const {st: stLine, dir: stDir} = supertrend(highs,lows,closes,atr14,10,3);
  const vwapLine = vwap(highs,lows,closes,vols);
  const volSma20 = sma(vols,20);
  const supportArr=[], resistanceArr=[];
  const LB=20;
  for(let i=0;i<n;i++){
    const s = Math.max(0,i-LB);
    supportArr[i] = Math.min(...lows.slice(s, i+1));
    resistanceArr[i] = Math.max(...highs.slice(s, i+1));
  }

  const perBar = rows.map((r,i)=>{
    let score=0; const reasons=[];

    // Trend alignment (EMA stack)
    if(ema20[i]!=null && ema50[i]!=null){
      if(ema200[i]!=null){
        if(ema20[i]>ema50[i] && ema50[i]>ema200[i]){ score+=2; reasons.push('EMA stack bullish (20>50>200)'); }
        else if(ema20[i]<ema50[i] && ema50[i]<ema200[i]){ score-=2; reasons.push('EMA stack bearish (20<50<200)'); }
        else if(ema20[i]>ema50[i]){ score+=0.7; } else { score-=0.7; }
      } else {
        if(ema20[i]>ema50[i]) score+=0.7; else score-=0.7;
      }
    }

    // ADX trend strength (direction-agnostic booster)
    if(adx14[i]!=null && adx14[i]>25){
      if(plusDI[i]>minusDI[i]) score+=1; else score-=1;
    }

    // RSI
    if(rsi14[i]!=null){
      if(rsi14[i]<30){ score+=1; reasons.push('RSI oversold'); }
      else if(rsi14[i]>70){ score-=1; reasons.push('RSI overbought'); }
    }

    // MACD histogram cross
    if(macdHist[i]!=null && i>0 && macdHist[i-1]!=null){
      if(macdHist[i-1]<=0 && macdHist[i]>0){ score+=1.5; reasons.push('MACD bullish cross'); }
      else if(macdHist[i-1]>=0 && macdHist[i]<0){ score-=1.5; reasons.push('MACD bearish cross'); }
      else if(macdHist[i]>0) score+=0.4; else score-=0.4;
    }

    // Supertrend flip
    if(stDir[i]!=null && i>0 && stDir[i-1]!=null){
      if(stDir[i-1]===-1 && stDir[i]===1){ score+=2; reasons.push('Supertrend flipped bullish'); }
      else if(stDir[i-1]===1 && stDir[i]===-1){ score-=2; reasons.push('Supertrend flipped bearish'); }
      else if(stDir[i]===1) score+=0.5; else score-=0.5;
    }

    // VWAP position
    if(vwapLine[i]!=null){
      if(closes[i]>vwapLine[i]) score+=0.5; else score-=0.5;
    }

    // Volume confirmation
    if(volSma20[i]!=null && vols[i]>volSma20[i]*1.3){
      if(closes[i]>r.open) { score+=0.5; reasons.push('above-average volume on up bar'); }
      else { score-=0.5; reasons.push('above-average volume on down bar'); }
    }

    // Breakout detection (vs prior N bars, excluding current)
    if(i>LB){
      const priorHigh = Math.max(...highs.slice(i-LB,i));
      const priorLow = Math.min(...lows.slice(i-LB,i));
      if(closes[i]>priorHigh){ score+=1.5; reasons.push('breakout above range'); }
      else if(closes[i]<priorLow){ score-=1.5; reasons.push('breakdown below range'); }
      // liquidity sweep
      if(highs[i]>priorHigh && closes[i]<priorHigh){ score-=1; reasons.push('liquidity sweep of highs (trap)'); }
      if(lows[i]<priorLow && closes[i]>priorLow){ score+=1; reasons.push('liquidity sweep of lows (trap)'); }
    }

    // Candlestick pattern
    const pattern = detectCandlePattern(rows, i);
    if(pattern==='bullish_engulfing'){ score+=1; reasons.push('bullish engulfing candle'); }
    else if(pattern==='bearish_engulfing'){ score-=1; reasons.push('bearish engulfing candle'); }

    return {score, reasons, pattern};
  });

  return { closes, highs, lows, vols, ema20, ema50, ema200, rsi14, macdHist, atr14, adx14, plusDI, minusDI, stLine, stDir, vwapLine, supportArr, resistanceArr, perBar };
}

const MAX_SCORE = 12.5;

function classifySignal(score){
  const abs = Math.abs(score);
  let label, tier;
  if(abs<2){ label='NO TRADE'; }
  else if(score>=6){ label='BUY LONG'; }
  else if(score>=3.5){ label='BUY LONG'; }
  else if(score>=2){ label='WAIT'; }
  else if(score<=-6){ label='SELL SHORT'; }
  else if(score<=-3.5){ label='SELL SHORT'; }
  else if(score<=-2){ label='WAIT'; }
  else { label='NO TRADE'; }

  const confidence = Math.max(15, Math.min(92, Math.round(abs/MAX_SCORE*100)));
  if(confidence>=75) tier='Very Strong';
  else if(confidence>=55) tier='Strong';
  else if(confidence>=35) tier='Medium';
  else tier='Weak';

  return {label, tier, confidence};
}

/* =========================================================================
   RENDERING
   ========================================================================= */
function fmt(n, digits){
  if(n==null || isNaN(n)) return '—';
  const d = digits!=null? digits : (n<1? 6 : 2);
  return n.toFixed(d);
}

function buildTelegramMessage(sym, sig, entry, tp1, tp2, tp3, sl, rr, cross20, tf){
  const arrow = sig.label==='BUY LONG' ? '🚀' : sig.label==='SELL SHORT' ? '🔻' : '⏳';
  return `${arrow} ${sig.label}

Coin
${sym}

Entry
Market

Cross
${fmt(cross20)}

Target 1
${fmt(tp1)}

Target 2
${fmt(tp2)}

Target 3
${fmt(tp3)}

Stop Loss
${fmt(sl)}

Risk Reward
${rr}

Confidence
${sig.confidence}%

Timeframe
${tf}

#Crypto
⚠️ Not financial advice`;
}

function renderSignalCard(sym, tf, analysis, lastRow){
  const i = analysis.closes.length-1;
  const bar = analysis.perBar[i];
  const sig = classifySignal(bar.score);
  const entry = lastRow.close;
  const atrVal = analysis.atr14[i] || (entry*0.01);
  const dec = entry<1?6:2;

  let tp1,tp2,tp3,sl,rr;
  if(sig.label==='BUY LONG'){
    sl = entry - 1.5*atrVal;
    tp1 = entry + 1*atrVal; tp2 = entry + 2*atrVal; tp3 = entry + 3.5*atrVal;
  } else if(sig.label==='SELL SHORT'){
    sl = entry + 1.5*atrVal;
    tp1 = entry - 1*atrVal; tp2 = entry - 2*atrVal; tp3 = entry - 3.5*atrVal;
  } else {
    sl = entry - 1.5*atrVal; tp1 = entry + 1*atrVal; tp2 = entry + 2*atrVal; tp3 = entry + 3.5*atrVal;
  }
  rr = `1:${(Math.abs(tp2-entry)/Math.abs(entry-sl)).toFixed(1)}`;

  document.getElementById('signalCard').style.display='block';
  document.getElementById('scSymbol').textContent = sym;
  document.getElementById('scTf').textContent = tf.toUpperCase();

  const labelEl = document.getElementById('scLabel');
  labelEl.textContent = sig.label;
  labelEl.className = 'sc-label ' + (sig.label==='BUY LONG'?'buy':sig.label==='SELL SHORT'?'sell':sig.label==='WAIT'?'wait':'notrade');
  document.getElementById('scTier').textContent = sig.tier;
  document.getElementById('scConfFill').style.width = sig.confidence+'%';
  document.getElementById('scConfNum').textContent = sig.confidence+'%';

  document.getElementById('scEntry').textContent = 'Market';
  document.getElementById('scPrice').textContent = fmt(entry,dec);
  document.getElementById('scTp1').textContent = fmt(tp1,dec);
  document.getElementById('scTp2').textContent = fmt(tp2,dec);
  document.getElementById('scTp3').textContent = fmt(tp3,dec);
  document.getElementById('scSl').textContent = fmt(sl,dec);
  document.getElementById('scRr').textContent = rr;

  const trendLabel = (analysis.ema20[i]>analysis.ema50[i]) ? 'Bullish' : 'Bearish';
  document.getElementById('scTrend').textContent = trendLabel;
  document.getElementById('scWhy').textContent = bar.reasons.length? bar.reasons.slice(0,5).join(' · ')+'.' : 'No strong multi-indicator confirmation right now — conditions are mixed or range-bound.';

  const cross20 = analysis.ema20[i];
  const msg = buildTelegramMessage(sym, sig, entry, tp1, tp2, tp3, sl, rr, cross20, tf.toUpperCase());
  document.getElementById('tgMsg').textContent = msg;

  // flash animation on new signal
  const card = document.getElementById('signalCard');
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');

  // notifications + sound for strong signals
  if((sig.label==='BUY LONG' || sig.label==='SELL SHORT') && sig.tier!=='Weak'){
    maybeNotify(sym, sig);
    playAlertBeep();
  }

  pushHistory({time:Date.now(), symbol:sym, tf, label:sig.label, confidence:sig.confidence, price:entry});

  return {sig, entry, tp1, tp2, tp3, sl, rr, dec};
}

function renderStats(sym, lastRow, prevClose, analysis, ticker24h){
  const i = analysis.closes.length-1;
  const chg = ((lastRow.close-prevClose)/prevClose*100);
  const atrPct = analysis.atr14[i]? (analysis.atr14[i]/lastRow.close*100) : null;
  const volLabel = atrPct==null? '—' : atrPct<1?'Low':atrPct<3?'Medium':'High';
  const trendLabel = trendClassification(analysis, i);
  const marketStatus = trendLabel.includes('Bullish') ? 'Bullish' : trendLabel.includes('Bearish') ? 'Bearish' : 'Neutral';

  const metrics = [
    {label:'Price', val: fmt(lastRow.close, lastRow.close<1?6:2), cls:'flat', sub: sym},
    {label:'24H change', val: ticker24h? (parseFloat(ticker24h.priceChangePercent)>=0?'+':'')+parseFloat(ticker24h.priceChangePercent).toFixed(2)+'%' : (chg>=0?'+':'')+chg.toFixed(2)+'%', cls: chg>=0?'up':'down', sub:'vs previous bar / 24h'},
    {label:'24H volume', val: ticker24h? Number(ticker24h.quoteVolume).toLocaleString(undefined,{maximumFractionDigits:0}) : '—', cls:'flat', sub:'quote volume'},
    {label:'Volatility (ATR%)', val: atrPct!=null? atrPct.toFixed(2)+'%':'—', cls: volLabel==='High'?'down':volLabel==='Low'?'up':'flat', sub: volLabel},
    {label:'Trend', val: trendLabel, cls: marketStatus==='Bullish'?'up':marketStatus==='Bearish'?'down':'flat', sub:'EMA structure'},
    {label:'Market status', val: marketStatus, cls: marketStatus==='Bullish'?'up':marketStatus==='Bearish'?'down':'flat', sub:'overall bias'},
    {label:'ADX (14)', val: analysis.adx14[i]!=null? analysis.adx14[i].toFixed(1):'—', cls: analysis.adx14[i]>25?'up':'flat', sub: analysis.adx14[i]>25?'trending':'ranging'},
    {label:'RSI (14)', val: analysis.rsi14[i]!=null? analysis.rsi14[i].toFixed(1):'—', cls: analysis.rsi14[i]>70?'down':analysis.rsi14[i]<30?'up':'flat', sub: analysis.rsi14[i]>70?'overbought':analysis.rsi14[i]<30?'oversold':'neutral'},
  ];
  document.getElementById('statsGrid').style.display='grid';
  document.getElementById('statsGrid').innerHTML = metrics.map(m=>`
    <div class="metric"><div class="m-label">${m.label}</div><div class="m-val ${m.cls}">${m.val}</div><div class="m-sub">${m.sub}</div></div>`).join('');
}

function trendClassification(analysis, i){
  const e20=analysis.ema20[i], e50=analysis.ema50[i], e200=analysis.ema200[i];
  if(e20==null||e50==null) return 'Neutral';
  if(e200!=null){
    if(e20>e50 && e50>e200) return 'Strong Bullish';
    if(e20<e50 && e50<e200) return 'Strong Bearish';
  }
  if(e20>e50) return 'Bullish';
  if(e20<e50) return 'Bearish';
  return 'Neutral';
}

function renderLevels(rows, analysis){
  const i = analysis.closes.length-1;
  const support = analysis.supportArr[i], resistance = analysis.resistanceArr[i];
  const dec = rows[i].close<1?6:2;
  document.getElementById('levelsPanel').style.display='block';
  document.getElementById('levelsGrid').innerHTML = `
    <div class="metric"><div class="m-label">Resistance (20-bar high)</div><div class="m-val down">${fmt(resistance,dec)}</div><div class="m-sub">recent seller-defended level</div></div>
    <div class="metric"><div class="m-label">Current price</div><div class="m-val flat">${fmt(rows[i].close,dec)}</div><div class="m-sub">${(((rows[i].close-support)/(resistance-support||1))*100).toFixed(0)}% through recent range</div></div>
    <div class="metric"><div class="m-label">Support (20-bar low)</div><div class="m-val up">${fmt(support,dec)}</div><div class="m-sub">recent buyer-defended level</div></div>
    <div class="metric"><div class="m-label">VWAP</div><div class="m-val flat">${fmt(analysis.vwapLine[i],dec)}</div><div class="m-sub">${rows[i].close>analysis.vwapLine[i]?'price above VWAP':'price below VWAP'}</div></div>
  `;
}

function renderIndicatorGrid(analysis){
  const i = analysis.closes.length-1;
  const items = [
    {l:'EMA 20', v: fmt(analysis.ema20[i])},
    {l:'EMA 50', v: fmt(analysis.ema50[i])},
    {l:'EMA 200', v: fmt(analysis.ema200[i])},
    {l:'RSI (14)', v: analysis.rsi14[i]!=null? analysis.rsi14[i].toFixed(1):'—'},
    {l:'MACD histogram', v: analysis.macdHist[i]!=null? analysis.macdHist[i].toFixed(5):'—'},
    {l:'ATR (14)', v: fmt(analysis.atr14[i])},
    {l:'ADX (14)', v: analysis.adx14[i]!=null? analysis.adx14[i].toFixed(1):'—'},
    {l:'+DI / -DI', v: (analysis.plusDI[i]!=null? analysis.plusDI[i].toFixed(1):'—') + ' / ' + (analysis.minusDI[i]!=null? analysis.minusDI[i].toFixed(1):'—')},
    {l:'Supertrend', v: analysis.stDir[i]===1?'Bullish':analysis.stDir[i]===-1?'Bearish':'—'},
    {l:'VWAP', v: fmt(analysis.vwapLine[i])},
    {l:'Support (20-bar)', v: fmt(analysis.supportArr[i])},
    {l:'Resistance (20-bar)', v: fmt(analysis.resistanceArr[i])},
  ];
  document.getElementById('indicatorPanel').style.display='block';
  document.getElementById('indGrid').innerHTML = items.map(it=>`
    <div class="ind-item"><div class="i-label">${it.l}</div><div class="i-val">${it.v}</div></div>`).join('');
}

/* ===== TradingView-style candlestick chart (lightweight-charts) ===== */
function renderTVChart(rows, analysis, interval){
  const container = document.getElementById('tvChart');
  document.getElementById('chartPanel').style.display='block';
  if(typeof LightweightCharts === 'undefined'){
    container.innerHTML = '<div style="padding:20px;color:#8ba0bb;font-size:12px;">Chart library failed to load (no internet reach to unpkg.com). Indicator numbers above are still accurate.</div>';
    return;
  }
  container.innerHTML = '';
  if(priceSeriesChart){ try{ priceSeriesChart.remove(); }catch(e){} }

  priceSeriesChart = LightweightCharts.createChart(container, {
    width: container.clientWidth, height: 340,
    layout:{ background:{color:'#050810'}, textColor:'#8ba0bb' },
    grid:{ vertLines:{color:'rgba(255,255,255,.04)'}, horzLines:{color:'rgba(255,255,255,.04)'} },
    rightPriceScale:{ borderColor:'rgba(255,255,255,.08)' },
    timeScale:{ borderColor:'rgba(255,255,255,.08)', timeVisible:true, secondsVisible:false },
    crosshair:{ mode: LightweightCharts.CrosshairMode.Normal },
  });
  candleSeries = priceSeriesChart.addCandlestickSeries({
    upColor:'#3ddc97', downColor:'#ef5a6f', borderVisible:false,
    wickUpColor:'#3ddc97', wickDownColor:'#ef5a6f'
  });
  candleSeries.setData(rows.map(r=>({ time: Math.floor(r.time/1000), open:r.open, high:r.high, low:r.low, close:r.close })));

  ema20Series = priceSeriesChart.addLineSeries({ color:'#14e0c4', lineWidth:1.5 });
  ema20Series.setData(rows.map((r,i)=> analysis.ema20[i]!=null? {time:Math.floor(r.time/1000), value:analysis.ema20[i]}:null).filter(Boolean));
  ema50Series = priceSeriesChart.addLineSeries({ color:'#f0a94e', lineWidth:1.5 });
  ema50Series.setData(rows.map((r,i)=> analysis.ema50[i]!=null? {time:Math.floor(r.time/1000), value:analysis.ema50[i]}:null).filter(Boolean));
  ema200Series = priceSeriesChart.addLineSeries({ color:'#8b7cf6', lineWidth:1.2 });
  ema200Series.setData(rows.map((r,i)=> analysis.ema200[i]!=null? {time:Math.floor(r.time/1000), value:analysis.ema200[i]}:null).filter(Boolean));

  // signal markers
  const markers = [];
  analysis.perBar.forEach((b,i)=>{
    const sig = classifySignal(b.score);
    if(sig.label==='BUY LONG' && sig.tier!=='Weak'){
      markers.push({time:Math.floor(rows[i].time/1000), position:'belowBar', color:'#3ddc97', shape:'arrowUp', text:'BUY'});
    } else if(sig.label==='SELL SHORT' && sig.tier!=='Weak'){
      markers.push({time:Math.floor(rows[i].time/1000), position:'aboveBar', color:'#ef5a6f', shape:'arrowDown', text:'SELL'});
    }
  });
  candleSeries.setMarkers(markers);
  priceSeriesChart.timeScale().fitContent();
}

function drawOsc(canvas, series, opts){
  const dpr = window.devicePixelRatio||1;
  const cssW = canvas.clientWidth||600, cssH = opts.height||90;
  canvas.width=cssW*dpr; canvas.height=cssH*dpr; canvas.style.height=cssH+'px';
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr); ctx.clearRect(0,0,cssW,cssH);
  const pad={l:44,r:12,t:10,b:16}; const w=cssW-pad.l-pad.r, h=cssH-pad.t-pad.b;
  const allVals = series.flatMap(s=>s.data.filter(v=>v!=null));
  if(!allVals.length) return;
  let min=Math.min(...allVals), max=Math.max(...allVals);
  if(opts.fixedRange){ min=opts.fixedRange[0]; max=opts.fixedRange[1]; }
  if(min===max){ min-=1; max+=1; }
  const pd=(max-min)*0.08; min-=pd; max+=pd;
  const n=series[0].data.length;
  const x=i=>pad.l+(i/(n-1))*w, y=v=>pad.t+h-((v-min)/(max-min))*h;
  ctx.strokeStyle='rgba(255,255,255,.06)'; ctx.lineWidth=1; ctx.font='10px ui-monospace, monospace'; ctx.fillStyle='#8ba0bb';
  for(let g=0; g<=3; g++){ const val=min+(max-min)*(g/3), yy=y(val); ctx.beginPath(); ctx.moveTo(pad.l,yy); ctx.lineTo(pad.l+w,yy); ctx.stroke(); ctx.fillText(val.toFixed(opts.decimals!=null?opts.decimals:1),2,yy+3); }
  if(opts.zeroLine){ const yy=y(0); ctx.strokeStyle='rgba(240,169,78,.4)'; ctx.beginPath(); ctx.moveTo(pad.l,yy); ctx.lineTo(pad.l+w,yy); ctx.stroke(); }
  series.forEach(s=>{
    if(s.type==='bars'){
      s.data.forEach((v,i)=>{ if(v==null) return; const barW=Math.max(1,w/n*0.6), yy0=y(0), yy1=y(v); ctx.fillStyle=v>=0?'rgba(61,220,151,.55)':'rgba(239,90,111,.55)'; ctx.fillRect(x(i)-barW/2, Math.min(yy0,yy1), barW, Math.abs(yy1-yy0)); });
      return;
    }
    ctx.beginPath(); let started=false;
    s.data.forEach((v,i)=>{ if(v==null) return; const xx=x(i),yy=y(v); if(!started){ctx.moveTo(xx,yy);started=true;} else ctx.lineTo(xx,yy); });
    ctx.strokeStyle=s.color; ctx.lineWidth=s.width||1.4; ctx.stroke();
  });
}

/* =========================================================================
   HISTORY
   ========================================================================= */
function pushHistory(entry){
  historyList.unshift(entry);
  if(historyList.length>100) historyList = historyList.slice(0,100);
  renderHistory();
}
function renderHistory(){
  document.getElementById('historyPanel').style.display='block';
  const search = document.getElementById('histSearch').value.trim().toUpperCase();
  const filter = document.getElementById('histFilter').value;
  const rowsHtml = historyList
    .filter(h=> (filter==='ALL'||h.label===filter) && (!search || h.symbol.includes(search)))
    .map(h=>{
      const cls = h.label==='BUY LONG'?'up':h.label==='SELL SHORT'?'down':'flat';
      const bg = h.label==='BUY LONG'?'rgba(61,220,151,.15)':h.label==='SELL SHORT'?'rgba(239,90,111,.15)':'rgba(240,169,78,.15)';
      const d = new Date(h.time);
      return `<tr><td>${d.toLocaleTimeString()}</td><td>${h.symbol}</td><td>${h.tf}</td><td><span class="tag ${cls}" style="background:${bg}">${h.label}</span></td><td>${h.confidence}%</td><td>${fmt(h.price, h.price<1?6:2)}</td></tr>`;
    }).join('');
  document.getElementById('histBody').innerHTML = rowsHtml || `<tr><td colspan="6" style="color:#8ba0bb;">No signals yet this session.</td></tr>`;
}
document.getElementById('histSearch').addEventListener('input', renderHistory);
document.getElementById('histFilter').addEventListener('change', renderHistory);
document.getElementById('histExportBtn').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(historyList,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download='signal-history.json'; a.click();
  URL.revokeObjectURL(url);
});
document.getElementById('histClearBtn').addEventListener('click', ()=>{
  historyList = []; renderHistory();
});

/* =========================================================================
   NOTIFICATIONS + SOUND
   ========================================================================= */
function maybeNotify(sym, sig){
  if(!notifEnabled || typeof Notification==='undefined' || Notification.permission!=='granted') return;
  if(sig.label==='BUY LONG' && typeof alertOnBuy!=='undefined' && !alertOnBuy) return;
  if(sig.label==='SELL SHORT' && typeof alertOnSell!=='undefined' && !alertOnSell) return;
  try{ new Notification(`${sig.label}: ${sym}`, { body:`${sig.tier} ${sig.confidence!==''?'· '+sig.confidence+'% confidence':''}`, silent:true }); }catch(e){}
}
function playAlertBeep(){
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type='sine'; osc.frequency.value=880;
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime+0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.35);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime+0.4);
  }catch(e){}
}
document.getElementById('notifBtn').addEventListener('click', async ()=>{
  if(typeof Notification==='undefined'){ alert('Notifications are not supported in this browser.'); return; }
  const perm = await Notification.requestPermission();
  notifEnabled = perm==='granted';
  document.getElementById('notifBtn').classList.toggle('active', notifEnabled);
});

/* =========================================================================
   NETWORK / STATUS
   ========================================================================= */
function setStatus(text){
  const line = document.getElementById('statusLine');
  line.style.display='flex';
  document.getElementById('statusText').textContent = text;
  document.getElementById('errorLine').style.display='none';
}
function setError(text){
  document.getElementById('statusLine').style.display='none';
  const el = document.getElementById('errorLine');
  el.style.display='block'; el.textContent = text;
}
function clearStatus(){
  document.getElementById('statusLine').style.display='none';
  document.getElementById('errorLine').style.display='none';
}
function updateNetBadge(){
  const online = navigator.onLine;
  document.getElementById('netDot').className = 'dot ' + (online?'on':'off');
  document.getElementById('netText').textContent = online? 'online' : 'offline';
}
window.addEventListener('online', updateNetBadge);
window.addEventListener('offline', updateNetBadge);
updateNetBadge();

async function fetchWithTimeout(url, ms){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), ms);
  try{
    const resp = await fetch(url, {signal: ctrl.signal});
    clearTimeout(t);
    return resp;
  } catch(e){
    clearTimeout(t);
    throw e;
  }
}

async function fetchKlinesWithFallback(symbol, interval, limit){
  if(!navigator.onLine){ throw {friendly:'No Internet Connection — check your connection and try again.'}; }
  setStatus('Checking Internet…');
  await new Promise(r=>setTimeout(r,200));
  for(let m=0; m<BINANCE_MIRRORS.length; m++){
    const mirror = BINANCE_MIRRORS[m];
    setStatus(m===0? 'Connecting Binance…' : `Switching Backup Server (${m+1}/${BINANCE_MIRRORS.length})…`);
    try{
      const url = `${mirror}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
      const resp = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      if(resp.status===400){
        const body = await resp.json().catch(()=>({}));
        if(body.code===-1121){ throw {friendly:'Invalid Symbol — that pair does not exist on Binance spot. Check spelling, e.g. BTCUSDT.'}; }
        throw {friendly:'Coin Not Found — Binance rejected that symbol.'};
      }
      if(resp.status===429 || resp.status===418){ setStatus('Server Busy — retrying…'); await new Promise(r=>setTimeout(r,600)); continue; }
      if(!resp.ok){ continue; }
      const data = await resp.json();
      if(!Array.isArray(data) || data.length===0){ continue; }
      let ticker24h = null;
      try{
        const tResp = await fetchWithTimeout(`${mirror}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, FETCH_TIMEOUT_MS);
        if(tResp.ok) ticker24h = await tResp.json();
      }catch(e){ /* non-fatal */ }
      setStatus('Market Data Loaded Successfully');
      setTimeout(clearStatus, 900);
      return {rows: data.map(k=>({ time:k[0], open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5] })), ticker24h};
    } catch(err){
      if(err && err.friendly) throw err;
      // try next mirror
      continue;
    }
  }
  throw {friendly:'Server Busy — all Binance endpoints are unreachable right now. Please try again shortly.'};
}

/* =========================================================================
   PRICE ALERTS + LONG/SHORT SIGNAL ALERTS
   (Panel is injected via JS so only script.js needs to change in the repo —
   no edits needed to index.html or style.css.)
   ========================================================================= */
let priceAlerts = []; // {id, symbol, price, dir:'above'|'below', triggered}
let alertOnBuy = true, alertOnSell = true;
let alertIdSeq = 1;

function injectAlertsPanel(){
  if(document.getElementById('alertsPanel')) return;
  const section = document.createElement('section');
  section.className = 'panel';
  section.id = 'alertsPanel';
  section.innerHTML = `
    <h2>Alerts <span class="muted">— price &amp; long/short signals</span></h2>
    <div class="field-row">
      <div class="field"><label>Target price (for current symbol)</label><input type="number" step="any" id="alertPriceInput" placeholder="e.g. 0.0055"></div>
      <div class="field"><label>Direction</label>
        <select id="alertDirSelect">
          <option value="above">Price goes above</option>
          <option value="below">Price goes below</option>
        </select>
      </div>
    </div>
    <div class="row">
      <button class="btn-primary" id="alertAddBtn">Add price alert</button>
    </div>
    <div class="hist-controls" style="margin-top:14px;">
      <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-dim);">
        <input type="checkbox" id="alertBuyToggle" checked> Alert on BUY LONG signals
      </label>
      <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--ink-dim);">
        <input type="checkbox" id="alertSellToggle" checked> Alert on SELL SHORT signals
      </label>
    </div>
    <div id="alertsListWrap" style="margin-top:12px;"></div>
    <div class="hint">Alerts fire as a browser notification + short beep (enable notifications with the 🔔 button top-right). Price alerts are checked on every scan / auto-refresh tick, so turn auto-refresh on for them to work while you're away from the tab.</div>
  `;
  const right = document.querySelector('.right');
  right.appendChild(section);

  document.getElementById('alertAddBtn').addEventListener('click', ()=>{
    const symbol = document.getElementById('symbolInput').value.trim().toUpperCase();
    const price = parseFloat(document.getElementById('alertPriceInput').value);
    const dir = document.getElementById('alertDirSelect').value;
    if(!symbol || isNaN(price)){ alert('Enter a valid target price first.'); return; }
    priceAlerts.push({id: alertIdSeq++, symbol, price, dir, triggered:false});
    document.getElementById('alertPriceInput').value = '';
    renderAlertsList();
  });
  document.getElementById('alertBuyToggle').addEventListener('change', e=>{ alertOnBuy = e.target.checked; });
  document.getElementById('alertSellToggle').addEventListener('change', e=>{ alertOnSell = e.target.checked; });

  renderAlertsList();
}

function renderAlertsList(){
  const wrap = document.getElementById('alertsListWrap');
  if(!wrap) return;
  if(priceAlerts.length===0){ wrap.innerHTML = `<div style="color:var(--ink-dim); font-size:12px;">No price alerts set yet.</div>`; return; }
  wrap.innerHTML = priceAlerts.map(a=>{
    const dec = a.price<1?6:2;
    const status = a.triggered ? '<span class="tag" style="background:rgba(20,224,196,.15); color:var(--teal);">TRIGGERED</span>' : '<span class="tag" style="background:rgba(240,169,78,.15); color:var(--amber);">WATCHING</span>';
    return `<div class="ind-item" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
      <div><b>${a.symbol}</b> ${a.dir==='above'?'&gt;':'&lt;'} ${a.price.toFixed(dec)} ${status}</div>
      <button class="btn-small danger" data-remove="${a.id}">Remove</button>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-remove]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      priceAlerts = priceAlerts.filter(a=>a.id !== parseInt(btn.dataset.remove));
      renderAlertsList();
    });
  });
}

function checkPriceAlerts(symbol, currentPrice){
  let changed = false;
  priceAlerts.forEach(a=>{
    if(a.triggered || a.symbol!==symbol) return;
    const hit = (a.dir==='above' && currentPrice>=a.price) || (a.dir==='below' && currentPrice<=a.price);
    if(hit){
      a.triggered = true; changed = true;
      maybeNotify(symbol, {label: a.dir==='above'?'PRICE ABOVE TARGET':'PRICE BELOW TARGET', confidence:'', tier:''});
      playAlertBeep();
    }
  });
  if(changed) renderAlertsList();
}

/* =========================================================================
   MAIN FLOW
   ========================================================================= */
async function runScan(){
  const symbol = normalizeSymbol(document.getElementById('symbolInput').value);
  document.getElementById('symbolInput').value = symbol;
  const interval = document.getElementById('intervalSelect').value;
  const limit = Math.min(500, Math.max(80, parseInt(document.getElementById('limitInput').value)||220));
  const fetchBtn = document.getElementById('fetchBtn');
  if(!symbol){ setError('Please enter a coin symbol, e.g. BTCUSDT.'); return; }

  fetchBtn.disabled = true;
  const originalLabel = fetchBtn.textContent;
  fetchBtn.textContent = 'Scanning…';

  try{
    const {rows, ticker24h} = await fetchKlinesWithFallback(symbol, interval, limit);
    if(rows.length < 60){ setError(`Not enough data returned (${rows.length} bars) — try a higher "Bars" value or a different timeframe.`); return; }

    document.getElementById('emptyState').style.display='none';
    const analysis = computeFullAnalysis(rows);
    const lastRow = rows[rows.length-1];
    const prevClose = rows.length>1? rows[rows.length-2].close : lastRow.close;

    renderSignalCard(symbol, interval, analysis, lastRow);
    renderStats(symbol, lastRow, prevClose, analysis, ticker24h);
    renderLevels(rows, analysis);
    renderTVChart(rows, analysis, interval);
    renderIndicatorGrid(analysis);
    checkPriceAlerts(symbol, lastRow.close);

    drawOsc(document.getElementById('oscCanvas'), [{data:analysis.rsi14, color:'#8b7cf6', width:1.4}], {height:90, fixedRange:[0,100], decimals:0});
    drawOsc(document.getElementById('macdCanvas'), [{data:analysis.macdHist, color:'#8b7cf6', type:'bars'}], {height:90, zeroLine:true, decimals:4});

    document.querySelectorAll('#chipGrid .chip').forEach(c=> c.classList.toggle('active', c.dataset.sym===symbol));
  } catch(err){
    console.error('Signal Scanner error:', err);
    setError(err && err.friendly ? err.friendly : ('Unexpected error — ' + (err && err.message ? err.message : 'please retry.')));
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.textContent = originalLabel;
  }
}

/* =========================================================================
   UI WIRING
   ========================================================================= */
function buildChips(){
  const grid = document.getElementById('chipGrid');
  grid.innerHTML = QUICK_SYMBOLS.map(s=>`<button class="chip" data-sym="${s}">${s.replace('USDT','/USDT')}</button>`).join('');
  grid.querySelectorAll('.chip').forEach(chip=>{
    chip.addEventListener('click', ()=>{
      document.getElementById('symbolInput').value = chip.dataset.sym;
      runScan();
    });
  });
}
buildChips();

document.getElementById('fetchBtn').addEventListener('click', runScan);
document.getElementById('customAddBtn').addEventListener('click', ()=>{
  const v = normalizeSymbol(document.getElementById('customSymbolInput').value);
  if(!v) return;
  document.getElementById('symbolInput').value = v;
  runScan();
});
document.getElementById('customSymbolInput').addEventListener('keydown', e=>{
  if(e.key==='Enter') document.getElementById('customAddBtn').click();
});
document.getElementById('symbolInput').addEventListener('keydown', e=>{
  if(e.key==='Enter') runScan();
});

document.getElementById('copyBtn').addEventListener('click', ()=>{
  const text = document.getElementById('tgMsg').textContent;
  navigator.clipboard.writeText(text).then(()=>{
    const btn = document.getElementById('copyBtn');
    const orig = btn.textContent; btn.textContent='Copied!';
    setTimeout(()=>btn.textContent=orig, 1500);
  }).catch(()=>{
    // fallback selection-based copy
    const range = document.createRange();
    range.selectNode(document.getElementById('tgMsg'));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    document.execCommand('copy');
  });
});

document.getElementById('autoToggleBtn').addEventListener('click', function(){
  if(autoTimer){
    clearInterval(autoTimer); autoTimer=null;
    this.textContent='Off'; this.classList.remove('active');
  } else {
    const secs = parseInt(document.getElementById('autoIntervalSelect').value)||30;
    runScan();
    autoTimer = setInterval(runScan, secs*1000);
    this.textContent='On'; this.classList.add('active');
  }
});

window.addEventListener('resize', ()=>{
  if(priceSeriesChart){
    const container = document.getElementById('tvChart');
    priceSeriesChart.applyOptions({ width: container.clientWidth });
  }
});

// initial load
buildChips();
injectAlertsPanel();
runScan();
