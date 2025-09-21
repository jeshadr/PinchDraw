// Elements
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const paint = document.getElementById('paint');
const cursor = document.getElementById('cursor');
const statusEl = document.getElementById('status');
const toast = document.getElementById('toast');

const colorEl = document.getElementById('color');
const sizeEl = document.getElementById('size');
const sizeVal = document.getElementById('sizeVal');
const sensEl = document.getElementById('sensitivity');
const sensVal = document.getElementById('sensVal');
const smoothingEl = document.getElementById('smoothing');
const smoothVal = document.getElementById('smoothVal');

const clearBtn = document.getElementById('clearBtn');
const saveBtn = document.getElementById('saveBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const cameraSelect = document.getElementById('cameraSelect');
const toggleGuidesBtn = document.getElementById('toggleGuides');
const togglePointerBtn = document.getElementById('togglePointer');
const runTestsBtn = document.getElementById('runTests');

const startBtn = document.getElementById('startBtn');
const gate = document.getElementById('gate');
const gateStart = document.getElementById('gateStart');
const gateDismiss = document.getElementById('gateDismiss');
const secureNote = document.getElementById('secureNote')?.querySelector('span');

const isSecureEl = document.getElementById('isSecure');
const permEl = document.getElementById('perm');
const facingEl = document.getElementById('facing');

const tracker = document.getElementById('tracker');
const tctx = tracker.getContext('2d');

// Tutorial elements
const tutorialPopup = document.getElementById('tutorialPopup');
const closeTutorialBtn = document.getElementById('closeTutorial');
const startTutorialBtn = document.getElementById('startTutorial');

// State
let showGuides = true;
let showPointer = false;

let ctxPaint = paint.getContext('2d');
let ctxOver = overlay.getContext('2d');

let handLandmarker = null; // Tasks Vision
let legacyHands = null;    // Legacy Hands fallback
let legacyLandmarks = null;
let legacyBusy = false;
let lastLegacyTime = -1;

let lastVideoTime = -1;
let running = false;
let streamRef = null;
let currentFacing = 'user';

let drawing = false;
let lastPt = null; // {x,y}
let smoothed = null;

let history = [];
let redoStack = [];

// Utils
function toastMsg(msg) {
  statusEl.textContent = msg;
  toast.textContent = msg;
  toast.className = 'toast show';
  setTimeout(() => { toast.className = 'toast'; }, 2000);
}
function hideGate(){ gate.style.display='none'; gate.style.pointerEvents='none'; }
function showGate(){ gate.style.display='grid'; gate.style.background='transparent'; gate.style.pointerEvents='auto'; }

function hideTutorial(){ tutorialPopup.style.display='none'; }
function showTutorial(){ tutorialPopup.style.display='flex'; }

function pushHistory() { try { history.push(paint.toDataURL('image/png')); if (history.length > 40) history.shift(); redoStack.length = 0; } catch(e) {} }
function restoreFrom(dataUrl) { return new Promise(resolve => { const img = new Image(); img.onload = () => { ctxPaint.clearRect(0,0,paint.width,paint.height); ctxPaint.drawImage(img,0,0,paint.width,paint.height); resolve(); }; img.src = dataUrl; }); }

// Event listeners
undoBtn.onclick = async () => { if (!history.length) return; const last = history.pop(); const current = paint.toDataURL('image/png'); redoStack.push(current); await restoreFrom(last); };
redoBtn.onclick = async () => { if (!redoStack.length) return; const next = redoStack.pop(); const current = paint.toDataURL('image/png'); history.push(current); await restoreFrom(next); };
clearBtn.onclick = () => { ctxPaint.clearRect(0,0,paint.width,paint.height); pushHistory(); };
saveBtn.onclick = () => { const a = document.createElement('a'); a.download = 'pinch-drawing.png'; a.href = paint.toDataURL('image/png'); a.click(); };

toggleGuidesBtn.onclick = () => { showGuides = !showGuides; };
togglePointerBtn.onclick = () => { showPointer = !showPointer; cursor.style.opacity = showPointer ? 1 : 0; };

sizeEl.oninput = () => sizeVal.textContent = sizeEl.value;
sensEl.oninput = () => sensVal.textContent = Number(sensEl.value).toFixed(3);
smoothingEl.oninput = () => smoothVal.textContent = Number(smoothingEl.value).toFixed(2);

cameraSelect.onchange = async () => {
  const val = cameraSelect.value;
  if (val === currentFacing) return;
  currentFacing = val;
  await initCamera(true);
};
startBtn.onclick = () => initCamera(false);
gateStart.onclick = () => initCamera(false);
gateDismiss.onclick = () => hideGate();

// Tutorial event listeners
closeTutorialBtn.onclick = () => {
  hideTutorial();
  localStorage.setItem('pinchdraw-tutorial-seen', 'true');
};
startTutorialBtn.onclick = () => {
  hideTutorial();
  localStorage.setItem('pinchdraw-tutorial-seen', 'true');
};

// Size canvases from the mirror box so overlay pixels match what you see
function fitCanvases() {
  const host = document.getElementById('mirror');
  const rect = host.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));
  const ratio = window.devicePixelRatio || 1;

  for (const c of [overlay, paint]) {
    c.width = Math.max(1, Math.floor(w * ratio));
    c.height = Math.max(1, Math.floor(h * ratio));
    c.style.width = w + 'px';
    c.style.height = h + 'px';
    const ctx = c.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
}

async function initCamera(forceRestart = false) {
  const secure = window.isSecureContext || location.hostname === 'localhost';
  try {
    if (!secure) { showGate(); toastMsg('Use HTTPS or localhost.'); return; }
    if (!streamRef || forceRestart) {
      if (streamRef) { streamRef.getTracks().forEach(t => t.stop()); streamRef = null; }
      const facingMode = currentFacing;
      facingEl && (facingEl.textContent = facingMode);
      const constraints = { video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef = stream; video.srcObject = streamRef;
      await video.play();
      await new Promise(r => { if (video.readyState >= 2) r(); else video.onloadedmetadata = () => r(); });
      fitCanvases(); hideGate(); statusEl.textContent = 'Camera ready';
    } else { hideGate(); }

    if (!handLandmarker && !legacyHands) {
      try { await setupHandsWithFallback(); statusEl.textContent = 'Tracker ready'; }
      catch(e){ console.warn('Tasks-Vision failed, switching to legacy:', e); toastMsg('Modern tracker blocked. Using fallback.'); await setupLegacyHands(); statusEl.textContent = 'Legacy tracker ready'; }
    }

    setTimeout(()=> statusEl.textContent = 'Ready', 300);
    running = true; requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    let message = 'Camera failed.';
    if (err && err.name === 'NotAllowedError') message = 'Permission denied. Allow the camera.';
    if (err && err.name === 'NotFoundError') message = 'No camera found.';
    if (err && err.name === 'NotReadableError') message = 'Camera already in use.';
    toastMsg(message); showGate();
  }
}

const BONES=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[0,9],[9,10],[10,11],[11,12],[0,13],[13,14],[14,15],[15,16],[0,17],[17,18],[18,19],[19,20]];
function vecDist(a,b){const dx=a.x-b.x;const dy=a.y-b.y;return Math.hypot(dx,dy)}
function drawLine(a,b){ ctxPaint.strokeStyle=colorEl.value; ctxPaint.lineWidth=Number(sizeEl.value); ctxPaint.lineCap='round'; ctxPaint.lineJoin='round'; ctxPaint.beginPath(); ctxPaint.moveTo(a.x,a.y); ctxPaint.lineTo(b.x,b.y); ctxPaint.stroke(); }

// Map normalized landmarks directly to canvas pixels
function projectToCanvas(norm,w,h){ return { x: norm.x * w, y: norm.y * h }; }

// Skeleton that matches the flipped canvas 1:1. No extra scale or offsets.
function drawSkeleton(ctx, w, h, L) {
  ctx.clearRect(0, 0, w, h);
  if (!L) return;
  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,.9)';
  ctx.fillStyle = 'rgba(255,255,255,.95)';
  ctx.beginPath();
  for (const [a, b] of BONES) {
    const p1 = { x: L[a].x * w, y: L[a].y * h };
    const p2 = { x: L[b].x * w, y: L[b].y * h };
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
  }
  ctx.stroke();
  for (const p of L) {
    const x = p.x * w;
    const y = p.y * h;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function renderGuides(landmarks,w,h){
  ctxOver.clearRect(0,0,overlay.width,overlay.height);
  if(!landmarks || !showGuides) return;
  drawSkeleton(ctxOver,w,h,landmarks);
}
function updateCursor(pt){ if(!showPointer) return; cursor.style.left=pt.x+'px'; cursor.style.top=pt.y+'px'; cursor.style.opacity=1; }

async function setupHandsWithFallback(){
  const versions=['0.10.14','latest'];
  const cdns=['https://cdn.jsdelivr.net/npm','https://unpkg.com'];
  let lastErr=null;
  for(const ver of versions){
    for(const cdn of cdns){
      try{
        if(!window.HandLandmarker||!window.FilesetResolver){
          await new Promise((resolve)=>{ const s=document.createElement('script'); s.src=`${cdn}/@mediapipe/tasks-vision@${ver}`; s.onload=resolve; s.onerror=resolve; document.head.appendChild(s); });
        }
        const FilesetResolver=window.FilesetResolver; const HandLandmarker=window.HandLandmarker;
        if(!FilesetResolver||!HandLandmarker) { lastErr = new Error('Tasks Vision globals missing'); continue; }
        const base=`${cdn}/@mediapipe/tasks-vision@${ver}/wasm`;
        const files=await FilesetResolver.forVisionTasks(base);
        handLandmarker=await HandLandmarker.createFromOptions(files,{ baseOptions:{ modelAssetPath:`${base}/hand_landmarker.task` }, runningMode:'VIDEO', numHands:1, minHandDetectionConfidence:0.5, minHandPresenceConfidence:0.5, minTrackingConfidence:0.5 });
        return;
      }catch(e){ lastErr=e; }
    }
  }
  if (lastErr) throw lastErr; throw new Error('Failed to initialize Tasks-Vision');
}

async function setupLegacyHands(){
  return new Promise((resolve, reject)=>{
    try{
      legacyHands = new Hands({ locateFile: (file)=>`https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
      legacyHands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      legacyHands.onResults((res)=>{ legacyLandmarks = res.multiHandLandmarks && res.multiHandLandmarks[0] ? res.multiHandLandmarks[0].map(p=>({x:p.x,y:p.y})) : null; });
      resolve();
    }catch(e){ reject(e); }
  });
}

async function loop(){
  const w = paint.width / (window.devicePixelRatio || 1);
  const h = paint.height / (window.devicePixelRatio || 1);

  let L=null;
  if(running && handLandmarker){
    const now=performance.now();
    if(video.currentTime!==lastVideoTime){ lastVideoTime=video.currentTime; const res=handLandmarker.detectForVideo(video,now); if(res&&res.landmarks&&res.landmarks[0]) L=res.landmarks[0]; }
  } else if (running && legacyHands){
    if (!legacyBusy && video.currentTime !== lastLegacyTime) {
      lastLegacyTime = video.currentTime; legacyBusy = true; legacyHands.send({ image: video }).catch(()=>{}).finally(()=>{ legacyBusy = false; });
    }
    L = legacyLandmarks;
  }

  // Mini tracker is not flipped by CSS. Draw it unflipped.
  tctx.clearRect(0,0,tracker.width,tracker.height);
  // Default skeleton disabled - only mirrored skeleton can be toggled

  if(L){
    const thumb=L[4]; const indexTip=L[8];
    const pinchDist=vecDist(thumb,indexTip);
    const threshold=Number(sensEl.value);

    const pt=projectToCanvas(indexTip,w,h);

    const alpha=Number(smoothingEl.value);
    if(!smoothed) smoothed={...pt};
    smoothed.x=smoothed.x*alpha+pt.x*(1-alpha);
    smoothed.y=smoothed.y*alpha+pt.y*(1-alpha);

    updateCursor(smoothed);
    renderGuides(L,w,h);

    const pinch=pinchDist<threshold;
    if(pinch && !drawing){ drawing=true; lastPt={...smoothed}; pushHistory(); }
    if(!pinch && drawing){ drawing=false; lastPt=null; }
    if(drawing){ if(lastPt) drawLine(lastPt,smoothed); lastPt={...smoothed}; }
  } else {
    ctxOver.clearRect(0,0,overlay.width,overlay.height); drawing=false; lastPt=null; cursor.style.opacity=0;
  }

  requestAnimationFrame(loop);
}

window.addEventListener('resize', fitCanvases);

// Start behavior
document.addEventListener('DOMContentLoaded', async () => {
  try {
    fitCanvases();
    
    // Check if user has seen tutorial before
    const hasSeenTutorial = localStorage.getItem('pinchdraw-tutorial-seen');
    if (!hasSeenTutorial) {
      showTutorial();
    }
    
    const perm = await navigator.permissions?.query({ name: 'camera' });
    if (perm && perm.state === 'granted') { await initCamera(false); }
    else { showGate(); statusEl.textContent = 'Click Start camera'; }
  } catch { showGate(); }
});

// Tests
function approxEqual(a,b,eps=1e-6){return Math.abs(a-b)<=eps}
function runUnitTests(){
  const results=[]; const W=1920,H=1080;
  results.push({name:'vecDist zero',pass:approxEqual(vecDist({x:0,y:0},{x:0,y:0}),0)});
  results.push({name:'vecDist diag',pass:approxEqual(vecDist({x:0,y:0},{x:3,y:4}),5)});
  const pMid=projectToCanvas({x:0.5,y:0.5},W,H);
  results.push({name:'project mid x',pass:approxEqual(pMid.x,W*0.5)});
  results.push({name:'project mid y',pass:approxEqual(pMid.y,H*0.5)});
  let s={x:0,y:0}; const alpha=0.6; const target={x:10,y:0}; s.x=s.x*alpha+target.x*(1-alpha); results.push({name:'smoothing moves toward target',pass:s.x>3.5 && s.x<4.5});
  const thumb={x:0.5, y:0.5}; const indexNear={x:0.52,y:0.5}; const indexFar={x:0.8, y:0.5}; const near=vecDist(thumb,indexNear); const far=vecDist(thumb,indexFar); const thresh=Number(document.getElementById('sensitivity').value);
  results.push({name:'pinch near below threshold',pass:near<thresh}); results.push({name:'pinch far above threshold',pass:far>thresh});
  const passed = results.filter(r=>r.pass).length; console.table(results); toastMsg(`Tests ${passed}/${results.length}`); return results;
}
document.getElementById('runTests').onclick = runUnitTests;
