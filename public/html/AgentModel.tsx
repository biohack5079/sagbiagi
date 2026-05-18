import React, { useRef, useEffect, useMemo } from 'react';
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

  // ボーン検索のキャッシュ化
  const findBone = (name: string): THREE.Object3D | undefined => {
    const target = name.toLowerCase();
    if (boneCache.has(target)) return boneCache.get(target);

    let result: THREE.Object3D | undefined;
    scene.traverse((n) => {
      if (n.name.toLowerCase().includes(target) && !result) {
        result = n;
      }
    });
    if (result) boneCache.set(target, result);
    return result;
  };

  // 初期ポーズとスケールの正規化
  useEffect(() => {
    if (!scene) return;
    const box = new THREE.Box3().setFromObject(scene);
    const size = box.getSize(new THREE.Vector3());
    const scale = 1.8 / size.y;
    scene.scale.set(scale, scale, scale);
    scene.position.y = -box.min.y * scale;
    
    // 初期ポーズ (Natural)
    const l = findBone('LeftUpperArm');
    const r = findBone('RightUpperArm');
    const ll = findBone('LeftLowerArm');
    const rr = findBone('RightLowerArm');
    const h = findBone('Head');
    if (l) l.rotation.set(0, 0, -1.3);  // 腕を下げる
    if (r) r.rotation.set(0, 0, 1.3);   // 腕を下げる
    if (ll) ll.rotation.set(0, 0, 0.2); // 少し内側に曲げる
    if (rr) rr.rotation.set(0, 0, -0.2);
    if (h) h.rotation.set(0, 0, 0);    // 頭を正面に
  }, [scene]);

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
        if (l) l.rotation.set(0, 0, -1.3);
        if (r) r.rotation.set(0, 0, 1.3);
        if (ll) ll.rotation.set(0, 0, 0.2);
        if (rr) rr.rotation.set(0, 0, -0.2);
        if (h) h.rotation.set(0, 0, 0);
    } else if (g.bone) {
        const bone = findBone(g.bone);
        if (bone) bone.rotation.set(...(g.rot as [number, number, number]));
    } else if (g.bones) {
        g.bones.forEach((bn: string) => {
          const bone = findBone(bn);
          if (bone) bone.rotation.set(...(g.rot as [number, number, number]));
        });
    }
  }, [currentGesture]);

  // 毎フレームのアニメーション（揺れ・リップシンク・特殊アクション）
  useFrame((state) => {
    const t = state.clock.getElapsedTime();
    const g = currentGesture ? GESTURES[currentGesture] : null;
    
    if (groupRef.current) {
      // 基本のアイドル回転
      groupRef.current.rotation.y = Math.sin(t * 0.5) * 0.05;
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
        if (l) l.rotation.set(0, 0, -0.8);
        if (r) r.rotation.set(0, 0, 0.8);
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