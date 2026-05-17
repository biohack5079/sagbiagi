/**
 * SAGBI DANCE FLOOR - 3D Agent & Animation (Module)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GLB_MODEL_PATH = `./agent.glb?v=${Date.now()}`;
const agentCanvas = document.getElementById('agent-canvas');

let threeScene, threeCamera, threeRenderer, threeClock, threeModel, controls;
let isAiTalking = false; 

// ストリーミング中のテキストを保持するバッファ
const responseBuffers = new Map();
// メッセージ要素自体を保持するMap（IDによる高速検索用）
const responseElements = new Map();
// 作成中のメッセージIDを追跡
const pendingMessages = new Set();
// すでに実行したアクションを記録（重複実行防止）
const triggeredActions = new Set();
const boneCache = new Map();

// --- Gestures (G1:M compatible) ---
const GESTURES = {
  wave: { bone: 'RightUpperArm', rot: [-1.2, 0, 1.2] },
  nod: { bone: 'Head', rot: [0.4, 0, 0] },
  joy: { action: 'jump' },
  jump: { action: 'jump' },
  dance: { action: 'dance' },
  shake_head: { action: 'shake_head' },
  bow: { bone: 'Head', rot: [0.6, 0, 0] },
  shrug: { action: 'shrug' },
  surprised: { action: 'surprised' },
  shy: { action: 'shy' },
  thinking: { bone: 'Head', rot: [0.2, 0.4, 0.2] },
  tilt_head: { bone: 'Head', rot: [0, 0, 0.3] },
  leftHandUp: { bones: ['LeftUpperArm'], rot: [0, 0, -1.4] },
  rightHandUp: { bones: ['RightUpperArm'], rot: [0, 0, 1.4] },
  raise_hand: { bones: ['RightUpperArm'], rot: [0, 0, 1.4] },
  leftHandDown: { bones: ['LeftUpperArm'], rot: [0, 0, 1.4] },
  rightHandDown: { bones: ['RightUpperArm'], rot: [0, 0, -1.4] },
  lower_hand: { pose: 'natural' },
  reset: { pose: 'natural' }
};

// --- Agent Response Handler (Exposed to index.html) ---
window.handleAgentResponse = (payload, fromName) => {
  if (!payload) return;
  const msgId = payload.id;
  const isAi = msgId && msgId.startsWith('ai-');
  const fullText = payload.text || '';

  // 1. 既存の吹き出しを探す
  let bubble = msgId ? (responseElements.get(msgId) || document.getElementById(msgId)) : null;

  if (!bubble && msgId && !pendingMessages.has(msgId)) {
    pendingMessages.add(msgId);
    if (window.addMessage) {
      // AIなら左側（false）、ユーザーなら右側（true）
      const isUser = msgId && msgId.startsWith('user-');
      const senderName = fromName || (isUser ? 'You' : 'sagbiちゃん');
      const newEl = window.addMessage(parseGestures(fullText, msgId) || '...', isUser, senderName, payload.image, msgId);

      if (newEl) {
        responseElements.set(msgId, newEl);
        bubble = newEl;
      }
    }
    pendingMessages.delete(msgId);
  }

  if (bubble) {
    const textContainer = bubble.querySelector('.content-text') || bubble;
    if (fullText) {
      // textContentを累積全文で「上書き」することで、細切れ表示を解消
      textContainer.textContent = parseGestures(fullText, msgId);
    }
  }

  // 完了フラグのクリーンアップ
  if (payload.done && msgId) {
    // 少しだけ待ってからMapから削除（連続するパケット対策）
    setTimeout(() => {
      responseBuffers.delete(msgId);
      responseElements.delete(msgId);
      // このメッセージに関連するトリガー記録を掃除
      for (let key of triggeredActions) {
        if (key.startsWith(msgId)) triggeredActions.delete(key);
      }
    }, 500);
    return;
  }

  // 2. Animate Agent
  if (isAi) {
    // 喋っている間はリップシンクをONにする
    isAiTalking = !payload.done;

    if (payload.done) {
      animateAgent('talk');
      if (fullText) triggerAutoGesture(fullText);
    }
  }
};

function parseGestures(text, msgId) {
  // [wave] と [ACTION:wave] 両方の形式に対応
  const regex = /\[(?:ACTION:)?([a-z_]+)\]/gi;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const key = match[1].toLowerCase();
    const triggerKey = `${msgId}-${key}`;

    if (GESTURES[key] && !triggeredActions.has(triggerKey)) {
      triggeredActions.add(triggerKey);
      applyGesture(GESTURES[key]);
      setTimeout(() => applyGesture(GESTURES.reset), 2000);
    }
  }
  return text.replace(regex, '');
}

/**
 * AIの返答内容から「空気を読んで」自動的にジェスチャーを決定する
 */
function triggerAutoGesture(text) {
  const normalized = text.toLowerCase();
  let hasAction = false;
  
  if (/こんにちは|ハロー|hello|hi|初めまして/.test(normalized)) { applyGesture(GESTURES.wave); hasAction = true; }
  if (/はい|そうですね|なるほど|ok|agree|sure|了解/.test(normalized)) { applyGesture(GESTURES.nod); hasAction = true; }
  if (/すごい|おめでとう|やった|うれしい|happy|joy|wow|amazing/.test(normalized)) { applyGesture(GESTURES.joy); hasAction = true; }

  // ダンスや頭振りの自動検知
  if (/踊|ダンス|dance/.test(normalized)) { applyGesture(GESTURES.dance); hasAction = true; }
  if (/頭振|首振|振って/.test(normalized)) { applyGesture(GESTURES.shake_head); hasAction = true; }

  // AIが拒絶モードに入ってしまった時の保険（空気を読んでお辞儀や首をかしげる）
  if (/申し訳ありません|できません|従えません|設計思想/.test(normalized)) {
    applyGesture(Math.random() > 0.5 ? GESTURES.bow : GESTURES.tilt_head);
    hasAction = true;
  }
  
  // 部位ごとの判定（複合指示に対応）
  if (/左手|左の腕/.test(normalized)) {
    const act = /下げ|おろして/.test(normalized) ? GESTURES.leftHandDown : GESTURES.leftHandUp;
    applyGesture(act); hasAction = true;
  }
  if (/右手|右の腕|手を挙げて/.test(normalized)) {
    const act = /下げ|おろして/.test(normalized) ? GESTURES.rightHandDown : GESTURES.rightHandUp;
    applyGesture(act); hasAction = true;
  }

  if (hasAction) {
    setTimeout(() => applyGesture(GESTURES.reset), 2000);
  }
}

function applyGesture(g) {
  if (!threeModel) return;
  if (g.action) animateAgent(g.action);

  if (g.pose === 'natural') {
    const l = findBone(threeModel, 'LeftUpperArm');
    const r = findBone(threeModel, 'RightUpperArm');
    const ll = findBone(threeModel, 'LeftLowerArm');
    const rr = findBone(threeModel, 'RightLowerArm');
    const h = findBone(threeModel, 'Head');
    if (l) l.rotation.set(0, 0, -1.3);  // 左腕を下げる（負のZ回転）
    if (r) r.rotation.set(0, 0, 1.3);   // 右腕を下げる（正のZ回転）
    if (ll) ll.rotation.set(0, 0, 0.2); // 少し内側に曲げる
    if (rr) rr.rotation.set(0, 0, -0.2);
    if (h) h.rotation.set(0, 0, 0);
  } else {
    if (g.bone) {
      const bone = findBone(threeModel, g.bone);
      if (bone) bone.rotation.set(...g.rot);
    }
    if (g.bones) {
      g.bones.forEach(bn => {
        const bone = findBone(threeModel, bn);
        if (bone) bone.rotation.set(...g.rot);
      });
    }
  }
}

function findBone(root, name) {
  const cacheKey = `${root.uuid}-${name}`;
  if (boneCache.has(cacheKey)) return boneCache.get(cacheKey);

  const target = name.toLowerCase();
  let result = null;
  root.traverse(n => {
    const boneName = n.name.toLowerCase();
    // 命名規則の差異（mixamorig_ 等）を考慮して柔軟にマッチング
    const isMatch = boneName.includes(target) || 
                    (target.includes('left') && (boneName.includes('_l_') || boneName.includes('left')) && (boneName.includes('arm') || boneName.includes('shoulder'))) ||
                    (target.includes('right') && (boneName.includes('_r_') || boneName.includes('right')) && (boneName.includes('arm') || boneName.includes('shoulder')));
    
    if (isMatch && !result) {
      result = n;
    }
  });

  if (result) boneCache.set(cacheKey, result);
  return result;
}

function animateAgent(action) {
  if (action === 'talk' && threeModel) {
    if (threeModel._isTalking) return;
    threeModel._isTalking = true;
    let count = 0;
    const id = setInterval(() => {
      threeModel.position.y += Math.sin(count) * 0.05;
      count++; if (count > 10) { clearInterval(id); threeModel.position.y = 0; threeModel._isTalking = false; }
    }, 60);
  } else if (action === 'jump' && threeModel) {
    let count = 0;
    const id = setInterval(() => {
      threeModel.position.y = Math.abs(Math.sin(count * 0.5)) * 0.2;
      count++; if (count > 20) { clearInterval(id); threeModel.position.y = 0; }
    }, 40);
  } else if (action === 'dance' && threeModel) {
    let count = 0;
    const id = setInterval(() => {
      threeModel.position.y = Math.abs(Math.sin(count * 0.6)) * 0.3; // もっと跳ねる
      threeModel.rotation.y = Math.sin(count * 0.4) * 0.8;          // もっとひねる
      count++; if (count > 40) { clearInterval(id); threeModel.position.y = 0; threeModel.rotation.y = 0; }
    }, 40);
  } else if (action === 'shake_head' && threeModel) {
    const head = findBone(threeModel, 'Head');
    if (!head) return;
    let count = 0;
    const id = setInterval(() => {
      // 頭を左右に振る（Y軸）
      head.rotation.y = Math.sin(count * 1.2) * 0.7; // 速く、大きく
      // 少し縦にも揺らすと自然
      head.rotation.x = Math.abs(Math.sin(count * 0.6)) * 0.3;
      count++; if (count > 40) { clearInterval(id); head.rotation.y = 0; head.rotation.x = 0; }
    }, 40);
  } else if (action === 'shrug' && threeModel) {
    const l = findBone(threeModel, 'LeftUpperArm');
    const r = findBone(threeModel, 'RightUpperArm');
    const h = findBone(threeModel, 'Head');
    if (l) l.rotation.set(0, 0, -0.8);
    if (r) r.rotation.set(0, 0, 0.8);
    if (h) h.rotation.set(0, 0, 0.2);
    setTimeout(() => applyGesture(GESTURES.reset), 1500);
  } else if (action === 'surprised' && threeModel) {
    threeModel.position.z = -0.5; // のけぞる
    const h = findBone(threeModel, 'Head');
    if (h) h.rotation.x = -0.4;
    setTimeout(() => {
      threeModel.position.z = 0;
      applyGesture(GESTURES.reset);
    }, 1000);
  } else if (action === 'shy' && threeModel) {
    const h = findBone(threeModel, 'Head');
    const r = findBone(threeModel, 'RightUpperArm');
    if (h) h.rotation.set(0.2, 0.4, 0.2); // 斜め下を向く
    if (r) r.rotation.set(-1.0, 0, 0.5); // 手を口元に持っていく
    let count = 0;
    const id = setInterval(() => {
      threeModel.rotation.y += Math.sin(count * 0.2) * 0.01; // もじもじ
      count++; if (count > 30) {
        clearInterval(id);
        applyGesture(GESTURES.reset);
      }
    }, 50);
  }
}

// --- Three.js Engine ---
function initThreeAgent() {
  if (!agentCanvas) return;
  const W = agentCanvas.clientWidth || 300, H = 220;
  
  threeScene = new THREE.Scene();
  threeCamera = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
  threeCamera.position.set(0, 1.3, 3.5);
  
  threeRenderer = new THREE.WebGLRenderer({ canvas: agentCanvas, alpha: true, antialias: true });
  threeRenderer.setSize(W, H);
  
  // マウス操作（回転・ズーム・移動）を追加
  controls = new OrbitControls(threeCamera, threeRenderer.domElement);
  controls.enableDamping = true; // 滑らかに動かす
  controls.target.set(0, 1.2, 0); // アバターの顔付近を回転の中心にする

  threeScene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const dirLight = new THREE.DirectionalLight(0xffeedd, 1.2);
  dirLight.position.set(1, 2, 1);
  threeScene.add(dirLight);
  
  threeClock = new THREE.Clock();

  new GLTFLoader().load(GLB_MODEL_PATH, (gltf) => {
    threeModel = gltf.scene;

    // --- モデルのサイズと位置の自動調整 ---
    const box = new THREE.Box3().setFromObject(threeModel);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    // 高さが1.8（人間の標準的な高さ）になるようにスケールを調整
    const scale = 1.8 / size.y;
    threeModel.scale.set(scale, scale, scale);

    // モデルの足元を原点 (0,0,0) に合わせる
    threeModel.position.x = -center.x * scale;
    threeModel.position.y = -box.min.y * scale; 
    threeModel.position.z = -center.z * scale;
    // ------------------------------------

    threeScene.add(threeModel);
    applyGesture(GESTURES.reset); // ロード直後に自然なポーズを適用
    console.log('[SAGBI] 3D Model Loaded.');
    if (window.updateStatus) window.updateStatus(""); // Hide on success
  }, (xhr) => {
    if (xhr.total > 0 && window.updateStatus) {
      // 圧縮の関係で100%を超えることがあるため、最大100に固定する
      const p = Math.min(100, Math.round(xhr.loaded / xhr.total * 100));
      window.updateStatus(`Loading Model: ${p}%`);
    }
  }, (err) => {
    console.error('[SAGBI] Model load failed', err);
    if (window.updateStatus) window.updateStatus("Model load failed.");
  });
  
  const animate = () => {
    requestAnimationFrame(animate);
    if (controls) controls.update(); // 操作状態を毎フレーム更新
    if (threeRenderer) {
      const t = threeClock.getElapsedTime();
      if (threeModel) {
        // リップシンク (口パク)
        if (isAiTalking) {
          const mouthOpen = (Math.sin(t * 15) + 1) * 0.5;
          threeModel.traverse(child => {
            if (child.morphTargetInfluences && child.morphTargetDictionary) {
              const index = child.morphTargetDictionary['A'] || 
                            child.morphTargetDictionary['Ah'] || 
                            child.morphTargetDictionary['mouthOpen'];
              if (index !== undefined) child.morphTargetInfluences[index] = mouthOpen;
            }
          });
        } else {
          // 喋っていない時は口を閉じる
          threeModel.traverse(child => {
            if (child.morphTargetInfluences) {
              const index = child.morphTargetDictionary?.['A'] || child.morphTargetDictionary?.['mouthOpen'];
              if (index !== undefined) child.morphTargetInfluences[index] = 0;
            }
          });
        }
        threeModel.rotation.y = Math.sin(t * 0.5) * 0.1;
        threeModel.position.y = Math.sin(t * 1.5) * 0.02;
      }
      threeRenderer.render(threeScene, threeCamera);
    }
  };
  animate();
}

// --- Startup ---
document.addEventListener('DOMContentLoaded', () => {
  try {
    initThreeAgent();
  } catch (e) { console.error('3D Init failed', e); }
});
