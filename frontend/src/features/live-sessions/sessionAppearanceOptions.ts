export const SESSION_COLORS = [
  { label: '默认', value: '' },
  { label: '蓝色', value: '#5287be' },
  { label: '绿色', value: '#54937d' },
  { label: '紫色', value: '#9571c4' },
  { label: '粉色', value: '#c67598' },
  { label: '橙色', value: '#c97864' },
  { label: '金色', value: '#b58a35' },
  { label: '红色', value: '#c65b5b' },
  { label: '深红', value: '#9b394d' },
  { label: '玫红', value: '#c94f87' },
  { label: '杏色', value: '#cd9a70' },
  { label: '柠檬黄', value: '#c1ac35' },
  { label: '草绿', value: '#91a64e' },
  { label: '翠绿', value: '#319870' },
  { label: '青绿', value: '#358e91' },
  { label: '天蓝', value: '#55a6c5' },
  { label: '靛蓝', value: '#606fba' },
  { label: '灰色', value: '#898b95' },
  { label: '石板灰', value: '#596d7e' },
] as const

// Quick picks, not a complete Unicode/iOS catalog. Split only on ASCII spaces
// so skin tones, flags and joined emoji sequences stay intact.
export const SESSION_EMOJI_GROUPS = {
  常用: '😊 🤖 🚀 🧪 📖 🪪 📦 🌍 🔧 🐱 ⭐ 🔥 🎯 💡 ✅ 📝 💻 🛠️ 👍 ❤️ 🎉 😍 😂 👀'.split(' '),
  笑脸与情绪: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😋 😎 🤩 🥳 🤔 🫡 🤫 🥹 😴 🤯 😭 😤 😱 🥶 🥵'.split(' '),
  手势与人物: '👍 👎 👏 🙌 🤝 🙏 💪 ✌️ 🤞 🤟 🫶 👋 👌 🤌 👀 🧠 👍🏻 👍🏽 👍🏿 👩‍💻 👨‍💻 🧑‍🔬 👩‍🚀 👨‍👩‍👧‍👦'.split(' '),
  动物与自然: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐧 🦉 🦋 🐝 🐢 🐙 🌱 🌸 🌵'.split(' '),
  食物与饮品: '🍎 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍑 🥑 🥕 🌽 🍞 🥐 🍕 🍔 🍟 🍜 🍣 🍰 🍪 🍩 ☕ 🧋'.split(' '),
  旅行与地点: '🚗 🚕 🚌 🚓 🚑 🚒 🚚 🚲 🛵 🚄 ✈️ 🚀 🛸 ⛵ 🚢 🗺️ 🏠 🏢 🏖️ 🏕️ 🏔️ 🗼 🗽 🌍'.split(' '),
  活动与物品: '⚽ 🏀 🏈 🎾 🏓 🏸 🏆 🥇 🎮 🎲 🎨 🎬 🎵 🎸 📷 📱 💻 ⌚ 💡 🔬 🔭 🔑 🧰 📚'.split(' '),
  符号与旗帜: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💯 ✅ ❌ ⚠️ ❓ ❗ ♻️ 🔒 🇨🇳 🇺🇸 🇬🇧 🇯🇵 🇸🇬 🇦🇺 🏳️‍🌈 🏳️‍⚧️'.split(' '),
} as const
