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

  // 全ボーンをあらかじめ小文字の名称でインデックス化
  const boneMap = useMemo(() => {
    const map = new Map<string, THREE.Object3D>();
    scene.traverse((node) => {
      map.set(node.name.toLowerCase(), node);
    });
    return map;
  }, [scene]);

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
  const findBone = useCallback((name: string): THREE.Object3D | undefined => {
    const target = name.toLowerCase();
    
    // 1. 完全一致（またはインデックス済み）
    if (boneMap.has(target)) return boneMap.get(target);

    // 2. VRM/VRoid 0.x 系特有の命名規則 (J_Bip_...) へのフォールバック
    if (target === 'head') return boneMap.get('j_bip_c_head') || boneMap.get('neck');
    
    // 3. 部分一致による検索
    let found: THREE.Object3D | undefined;
    for (const [boneName, node] of boneMap.entries()) {
      const isSideMatch = (target.includes('left') && (boneName.includes('left') || boneName.includes('_l'))) ||
                          (target.includes('right') && (boneName.includes('right') || boneName.includes('_r')));
      
      if (!isSideMatch && !target.includes('head') && !target.includes('ear') && !target.includes('leg')) continue;

      // 部位の判定
      const isPartMatch = 
        (target.includes('lower') && (boneName.includes('lower') || boneName.includes('fore'))) ||
        (target.includes('upper') && (boneName.includes('upper') || (boneName.includes('arm') && !boneName.includes('lower')))) ||
        (target.includes('ear') && boneName.includes('ear')) ||
        (target.includes('leg') && boneName.includes('leg'));

      if (isSideMatch && isPartMatch) {
        found = node;
        break;
      }
    }

    return found;
  }, [boneMap]);

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
    
    // 腕が「うんと上がった状態」を修正。
    // VRMモデルのデフォルトポーズを活かすため、一旦 0（または極微小値）にリセットします。
    // もしこれでも高い場合は、ここを 1.2 と -1.2 にすると腕が体側に下がります。
    if (l) l.rotation.set(0, 0, 0.1); 
    if (r) r.rotation.set(0, 0, -0.1);
    // VRoidの肘(LowerArm)は主にX軸で曲がります
    if (ll) ll.rotation.set(-0.3, 0, 0); 
    if (rr) rr.rotation.set(-0.3, 0, 0);
    
    const settleTimer = setTimeout(() => {
      hairBones.forEach(({ bone, original }) => {
        bone.rotation.copy(original); // 髪の毛の初期回転を復元
      });
    }, 800); // 髪の毛が落ち着くまでの時間

    const earTimer = setTimeout(() => {
      const earL = findBone('LeftEar') || findBone('Ear_L');
      const earR = findBone('RightEar') || findBone('Ear_R');
      if (earL && earR) {
        earL.rotation.z = 0.6; // 少し強めに動かす
        earR.rotation.z = -0.6;
        setTimeout(() => {
          earL.rotation.z = -0.7; 
          earR.rotation.z = 0.7;
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
        const earL = findBone('LeftEar') || findBone('Ear_L'); // 耳のボーンも取得
        const earR = findBone('RightEar') || findBone('Ear_R'); // 耳のボーンも取得

        if (l) l.rotation.set(5, 5, 0);
        if (r) r.rotation.set(0, 0, 5);
        if (ll) ll.rotation.set(-0.3, 0, 0);
        if (rr) rr.rotation.set(-0.3, 0, 0);
        if (earL) earL.rotation.set(0, 0, -0.7);
        if (earR) earR.rotation.set(0, 0, 0.7);
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
        const lul = findBone('LeftUpperLeg');
        const rul = findBone('RightUpperLeg');
        if (lul) lul.rotation.x = -Math.abs(Math.sin(t * 15)) * 0.5;
        if (rul) rul.rotation.x = -Math.abs(Math.sin(t * 15)) * 0.5;
      } else if (g?.action === 'dance') {
        groupRef.current.position.y += Math.abs(Math.sin(t * 15)) * 0.3;
        groupRef.current.rotation.y += Math.sin(t * 10) * 0.8;
        const lul = findBone('LeftUpperLeg');
        const rul = findBone('RightUpperLeg');
        if (lul) lul.rotation.x = Math.sin(t * 10) * 0.5;
        if (rul) rul.rotation.x = -Math.sin(t * 10) * 0.5;
      } else if (g?.action === 'walk') {
        // 歩行アニメーション: 左右の足を交互に振る
        const lul = findBone('LeftUpperLeg');
        const rul = findBone('RightUpperLeg');
        const speed = 10;
        if (lul) lul.rotation.x = Math.sin(t * speed) * 0.4;
        if (rul) rul.rotation.x = -Math.sin(t * speed) * 0.4;
        groupRef.current.position.y += Math.abs(Math.sin(t * speed)) * 0.05;
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