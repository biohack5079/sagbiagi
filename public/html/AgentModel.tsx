import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { GESTURES } from './agent';

interface Props {
  isTalking: boolean;
  currentGesture?: string;
  modelPath: string;
}

export const AgentModel: React.FC<Props> = ({ isTalking, currentGesture, modelPath }) => {
  const { scene } = useGLTF(modelPath);
  const groupRef = useRef<THREE.Group>(null);
  const boneCache = useMemo(() => new Map<string, THREE.Object3D>(), [scene]);

  /**
   * VRoidモデルのボーンを名前で検索します。
   * VRoid/VRMモデルはボーン名に様々な命名規則（例: "J_Bip_L_UpperArm", "LeftUpperArm", "mixamorig:LeftArm"）
   * を使用するため、部分一致や左右の識別子（_L, _R）を考慮して柔軟に検索します。
   *
   * @param name 検索するボーンの論理名 (例: 'Head', 'LeftUpperArm', 'RightLowerArm', 'LeftEar')
   * @returns 見つかったTHREE.Object3D (ボーン) または undefined
   *
   * VRoidボーン命名規則の例:
   * - 頭部: 'Head', 'J_Bip_C_Head'
   * - 上腕: 'LeftUpperArm', 'J_Bip_L_UpperArm', 'mixamorig:LeftArm'
   * - 前腕: 'LeftLowerArm', 'J_Bip_L_ForeArm', 'mixamorig:LeftForeArm'
   * - 耳: 'LeftEar', 'Ear_L'
   */
  // ボーン検索のキャッシュ化
  const findBone = useCallback((name: string): THREE.Object3D | undefined => {
    const target = name.toLowerCase();
    if (boneCache.has(target)) return boneCache.get(target);

    let result: THREE.Object3D | undefined;
    scene.traverse((n) => {
      const boneName = n.name.toLowerCase();
      // 頭部・耳ボーンの判定
      if (target === 'head' && (boneName === 'head' || boneName === 'j_bip_c_head' || boneName === 'neck')) {
        result = n;
      }
      if (!result) {
        // 左右の判定
        const isSideMatch = (target.includes('left') && (boneName.includes('left') || boneName.includes('_l'))) ||
                            (target.includes('right') && (boneName.includes('right') || boneName.includes('_r')));
        // 上腕(Upper)と前腕(Lower)の厳密な区別
        const isPartMatch = (target.includes('lower') === (boneName.includes('lower') || boneName.includes('fore'))) &&
                            (target.includes('upper') === (boneName.includes('upper') || (boneName.includes('arm') && !boneName.includes('lower') && !boneName.includes('fore'))));

        const isMatch = (boneName === target) || (isSideMatch && isPartMatch && (boneName.includes('arm') || boneName.includes('shoulder')));
        if (isMatch) result = n;
      }
      // 耳の検索を個別に追加
      if (!result && target.includes('ear') && boneName.includes(target)) {
        result = n;
      }
    });
    if (result) boneCache.set(target, result);
    return result;
  }, [scene, boneCache]);

  // 初期ポーズとスケールの正規化
  useEffect(() => {
    if (!scene) return;
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = 1.8 / size.y;
    scene.scale.set(scale, scale, scale);
    scene.position.y = -box.min.y * scale;
    scene.position.z = 0;

    // 前回の修正で向きが逆転した可能性があるため、一旦デフォルトに戻します
    scene.rotation.y = 0; 
    
    // 白目・マテリアル不具合対策
    // 表示崩れ（白目など）対策
    scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        (obj as THREE.Mesh).frustumCulled = false;
        const mat = (obj as THREE.Mesh).material;
        if (mat) {
          if (Array.isArray(mat)) {
            mat.forEach((m) => (m.needsUpdate = true));
          } else {
            mat.needsUpdate = true;
          }
        }
      }
    });

    // 髪の毛ボーンの参照と初期回転を保持
    const hairBones: { bone: THREE.Bone; original: THREE.Euler }[] = [];

    scene.traverse(obj => { 
      if (obj instanceof THREE.Bone) {
        obj.rotation.order = 'YXZ';

        if (obj.name.toLowerCase().includes('hair')) {
          hairBones.push({ bone: obj, original: obj.rotation.clone() });
          obj.rotation.set(0, 0, 0); // 0にすると多くのVRoidで逆立ちます
        }
      }
    });

    const l = findBone('LeftUpperArm');
    const r = findBone('RightUpperArm');
    const ll = findBone('LeftLowerArm');
    const rr = findBone('RightLowerArm');
    
    // refer/g1m/main.js の初期ポーズ（手を斜め下に下ろしたリラックスした状態）を再現。
    // VRoidモデルではUpperArmのZ軸回転で腕の上下、LowerArmのX軸回転で肘の曲げを制御することが多い。
    // 左右で回転方向が逆になる点に注意。
    // この設定は、モデルのデフォルト姿勢が腕を広げている場合に、自然な立ち姿にするためのものです。
    if (l) l.rotation.set(0, 0, 1.3); 
    if (r) r.rotation.set(0, 0, -1.3);
    // VRoidの肘(LowerArm)は主にX軸で曲がります
    if (ll) ll.rotation.set(-0.3, 0, 0); 
    if (rr) rr.rotation.set(-0.3, 0, 0);
    
    const settleTimer = setTimeout(() => {
      hairBones.forEach(({ bone, original }) => {
        bone.rotation.copy(original);
      });
    }, 800);

    const earTimer = setTimeout(() => {
      const earL = findBone('LeftEar') || findBone('Ear_L');
      const earR = findBone('RightEar') || findBone('Ear_R');
      if (earL && earR) {
        earL.rotation.z = 0.6; // 少し強めに動かす
        earR.rotation.z = -0.6;
        setTimeout(() => {
          earL.rotation.z = 0;
          earR.rotation.z = 0;
        }, 400);
      }
    }, 1500);

    return () => {
      clearTimeout(settleTimer);
      clearTimeout(earTimer);
    };
  }, [scene, findBone]);

  // ジェスチャーの状態変化に応じたボーン操作
  useEffect(() => {
    if (!currentGesture || !GESTURES[currentGesture]) return;
    const g = GESTURES[currentGesture];
    
    if (g.pose === 'natural') {
        const l = findBone('LeftUpperArm');
        const r = findBone('RightUpperArm');
        const ll = findBone('LeftLowerArm');
        const rr = findBone('RightLowerArm');
        const h = findBone('Head');
        if (l) l.rotation.set(0, 0, 1.3);
        if (r) r.rotation.set(0, 0, -1.3);
        if (ll) ll.rotation.set(-0.3, 0, 0);
        if (rr) rr.rotation.set(-0.3, 0, 0);
    } else if (g.bone) {
        const bone = findBone(g.bone);
        if (bone) bone.rotation.set(...(g.rot as [number, number, number]));
    } else if (g.bones) {
        g.bones.forEach((bn: string) => {
          const bone = findBone(bn);
          if (bone) bone.rotation.set(...(g.rot as [number, number, number]));
        });
    }
  }, [currentGesture, findBone]);

  // 毎フレームのアニメーション（揺れ・リップシンク・特殊アクション）
  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    const g = currentGesture ? GESTURES[currentGesture] : null;
    
    if (groupRef.current) {
      // 基本のアイドル回転
      groupRef.current.rotation.y = Math.sin(t * 0.5) * 0.05; // 既にsceneを反転させたので、ここは微細な揺れのみ
      groupRef.current.position.y = 0;
      groupRef.current.position.z = 0;

      // 発話中の物理的挙動
      if (isTalking) {
        groupRef.current.position.y += Math.sin(t * 10) * 0.02;
      }

      // アクションごとの挙動 (chat.jsのanimateAgent相当)
      if (g?.action === 'jump') {
        groupRef.current.position.y += Math.abs(Math.sin(t * 15)) * 0.2;
      } else if (g?.action === 'dance') {
        groupRef.current.position.y += Math.abs(Math.sin(t * 15)) * 0.3;
        groupRef.current.rotation.y += Math.sin(t * 10) * 0.8;
      } else if (g?.action === 'shake_head') {
        const head = findBone('Head');
        if (head) {
          head.rotation.y = Math.sin(t * 15) * 0.7;
          head.rotation.x = Math.abs(Math.sin(t * 7.5)) * 0.3;
        }
      } else if (g?.action === 'shrug') {
        const l = findBone('LeftUpperArm');
        const r = findBone('RightUpperArm');
        const h = findBone('Head');
        if (l) l.rotation.set(0, 0, 0.8);
        if (r) r.rotation.set(0, 0, -0.8);
        if (h) h.rotation.set(0, 0, 0.2);
      } else if (g?.action === 'surprised') {
        groupRef.current.position.z = -0.5;
        const h = findBone('Head');
        if (h) h.rotation.x = -0.4;
      } else if (g?.action === 'shy') {
        const h = findBone('Head');
        const r = findBone('RightUpperArm');
        if (h) h.rotation.set(0.2, 0.4, 0.2);
        if (r) r.rotation.set(-1.0, 0, 0.5);
        groupRef.current.rotation.y += Math.sin(t * 5) * 0.05;
      } else {
        // アクションがない時の微細な揺れ
        groupRef.current.position.y += Math.sin(t * 1.5) * 0.01;
      }
    }

    // モーフターゲットによるリップシンク
    scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.morphTargetInfluences && mesh.morphTargetDictionary) {
        const index = mesh.morphTargetDictionary['A'] || 
                      mesh.morphTargetDictionary['Ah'] || 
                      mesh.morphTargetDictionary['mouthOpen'];
        if (index !== undefined) {
          mesh.morphTargetInfluences[index] = isTalking ? (Math.sin(t * 15) + 1) * 0.5 : 0;
        }
      }
    });
  });

  return <primitive ref={groupRef} object={scene} />;
};