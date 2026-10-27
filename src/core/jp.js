// Japanese -> English for bone, object and material names (MMD models and
// Blender files saved with a Japanese UI), so the AI and the Scene list can
// tell what each part is. Names that are already English come back as null.

const WORDS = [
  // rig structure
  ['全ての親', 'master'], ['センター', 'center'], ['グルーブ', 'groove'], ['操作中心', 'control center'], ['揺れ物親', 'physics parent'],
  ['腰キャンセル', 'waist cancel'], ['キャンセル', 'cancel'],
  ['上半身3', 'upper body 3 (upper chest)'], ['上半身2', 'upper body 2 (chest)'], ['上半身', 'upper body (spine)'], ['下半身', 'lower body (pelvis)'],
  ['腰', 'waist (hips)'], ['首', 'neck'], ['頭', 'head'],
  // face
  ['両目', 'both eyes'], ['目', 'eye'], ['瞳', 'pupil'], ['眉', 'eyebrow'], ['まぶた', 'eyelid'], ['まつ毛', 'eyelash'], ['睫毛', 'eyelash'],
  ['口角', 'mouth corner'], ['口', 'mouth'], ['唇', 'lip'], ['舌', 'tongue'], ['歯', 'teeth'], ['あご', 'jaw'], ['顎', 'jaw'],
  ['頬', 'cheek'], ['ほほ', 'cheek'], ['耳', 'ear'], ['鼻', 'nose'], ['顔', 'face'], ['表情', 'expression'],
  // hair
  ['前髪', 'bangs (front hair)'], ['後髪', 'back hair'], ['後ろ髪', 'back hair'], ['横髪', 'side hair'], ['もみあげ', 'sideburn'],
  ['アホ毛', 'ahoge (hair strand)'], ['あほ毛', 'ahoge (hair strand)'], ['ツインテール', 'twin tail'], ['ツインテ', 'twin tail'], ['ポニーテール', 'ponytail'], ['ポニテ', 'ponytail'],
  ['おさげ', 'braid'], ['三つ編み', 'braid'], ['髪', 'hair'], ['毛', 'hair'],
  // arms and hands
  ['肩P', 'shoulder P (helper)'], ['肩C', 'shoulder C (helper)'], ['肩', 'shoulder'], ['腕捩', 'arm twist'], ['手捩', 'wrist twist'], ['捩', 'twist'],
  ['腕', 'arm (upper arm)'], ['ひじ', 'elbow (forearm)'], ['肘', 'elbow (forearm)'], ['尺骨', 'ulna (forearm helper)'], ['手首', 'wrist (hand)'], ['手先', 'hand tip'], ['手のひら', 'palm'], ['手', 'hand'],
  ['親指', 'thumb'], ['人差し指', 'index finger'], ['人差指', 'index finger'], ['人指', 'index finger'], ['中指', 'middle finger'], ['薬指', 'ring finger'], ['小指', 'little finger'], ['指', 'finger'],
  // body
  ['胸', 'chest'], ['乳', 'breast'], ['腹', 'belly'], ['へそ', 'navel'], ['背中', 'back'], ['尻', 'butt'], ['局部', 'groin'],
  // legs
  ['足首', 'ankle (foot)'], ['足先EX', 'toe EX'], ['つま先', 'toe'], ['爪先', 'toe'], ['足', 'leg (thigh)'], ['脚', 'leg'], ['ひざ', 'knee (shin)'], ['膝', 'knee (shin)'], ['太もも', 'thigh'], ['太腿', 'thigh'], ['すね', 'shin'], ['かかと', 'heel'],
  // creature parts
  ['尻尾', 'tail'], ['しっぽ', 'tail'], ['シッポ', 'tail'], ['角', 'horn'], ['羽', 'wing'], ['翼', 'wing'], ['ケモミミ', 'animal ear'], ['獣耳', 'animal ear'],
  // clothes and accessories
  ['スカート', 'skirt'], ['袖', 'sleeve'], ['リボン', 'ribbon'], ['ネクタイ', 'tie'], ['帽子', 'hat'], ['服', 'clothes'], ['上着', 'jacket'], ['靴下', 'socks'], ['靴', 'shoes'],
  ['フード', 'hood'], ['マント', 'cape'], ['ベルト', 'belt'], ['アクセ', 'accessory'], ['飾り', 'ornament'], ['紐', 'string'], ['裾', 'hem'], ['襟', 'collar'], ['手袋', 'glove'],
  // helpers and modifiers
  ['揺れ物', 'physics'], ['揺れ', 'sway'], ['物理', 'physics'], ['剛体', 'rigid body'], ['ジョイント', 'joint'], ['ダミー', 'dummy'], ['補助', 'helper'], ['調整', 'adjust'],
  ['ガイド', 'guide'], ['操作', 'control'], ['曲切', 'bend split'], ['伸び', 'stretch'], ['回転', 'rotation'], ['移動', 'move'], ['追加', 'added'],
  ['親', 'parent'], ['先', 'tip'], ['元', 'base'], ['根', 'root'], ['副', 'sub'], ['中心', 'center'], ['先端', 'tip'],
  ['左', 'left '], ['右', 'right '], ['上', 'upper '], ['下', 'lower '], ['前', 'front '], ['後', 'back '], ['横', 'side '], ['内', 'inner '], ['外', 'outer '],
  // Blender's Japanese UI default names
  ['立方体', 'cube'], ['平面', 'plane'], ['円柱', 'cylinder'], ['円錐', 'cone'], ['円', 'circle'], ['球', 'sphere'], ['トーラス', 'torus'], ['モンキー', 'monkey'],
  ['アーマチュア', 'armature'], ['ボーン', 'bone'], ['カメラ', 'camera'], ['ライト', 'light'], ['エンプティ', 'empty'], ['テキスト', 'text'], ['パス', 'path'], ['カーブ', 'curve'],
  ['マテリアル', 'material'], ['テクスチャ', 'texture'], ['メッシュ', 'mesh'], ['コレクション', 'collection'], ['体', 'body'], ['本体', 'body'],
].sort((a, b) => b[0].length - a[0].length);

const HAS_JP = /[぀-ヿ㐀-鿿ｦ-ﾟ]/;

export function hasJapanese(name) { return HAS_JP.test(String(name || '')); }

// '左足ＩＫ' -> 'left leg (thigh) IK'; null when there's nothing to translate
export function translateName(name) {
  let s = String(name || '');
  if (!HAS_JP.test(s)) return null;
  if (s.normalize) s = s.normalize('NFKC');
  for (const [jp, en] of WORDS) if (s.includes(jp)) s = s.split(jp).join(' ' + en + ' ');
  s = s.replace(/\s+([._])/g, '$1').replace(/([._])\s+/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return s;
}

// "name (translation)" for prompts and tooltips
export function nameWithTranslation(name) {
  const t = translateName(name);
  return t && t !== name ? `${name} (${t})` : String(name);
}
