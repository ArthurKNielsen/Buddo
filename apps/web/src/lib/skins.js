/** Site themes. Each one sets its own light or dark mode, except Classic, which follows the Theme and Accent settings. */
export const SKINS = [
  { id: 'studio', name: 'Studio', mode: 'light', blurb: 'Machined, tactile, colour-coded', colors: ['#DCDDE1', '#FFFFFF', '#111114', '#FF5A1F'] },
  { id: 'night', name: 'Studio Night', mode: 'dark', blurb: 'Studio after hours', colors: ['#0B0C0E', '#1A1B1F', '#ECECEE', '#FF7A3D'] },
  { id: 'aurora', name: 'Aurora', mode: 'dark', blurb: 'Frosted glass over moving light', colors: ['#06070D', '#151827', '#B8A6FF', '#7DD3FC'] },
  { id: 'playroom', name: 'Playroom', mode: 'light', blurb: 'Squishy, bright and bouncy', colors: ['#E7E4FA', '#FFFFFF', '#6B4EFF', '#2FB4EE'] },
  { id: 'terminal', name: 'Terminal', mode: 'dark', blurb: 'Amber phosphor, all mono', colors: ['#0D0B08', '#17130D', '#FFB547', '#7A5A2A'] },
  { id: 'matcha', name: 'Matcha', mode: 'light', blurb: 'Calm greens and paper', colors: ['#E9EDE4', '#FBFCF8', '#2F5D46', '#C9A227'] },
  { id: 'classic', name: 'Classic', mode: null, blurb: 'The original Buddo look', colors: ['#08080B', '#131318', '#8B5CF6', '#22D3EE'] },
];
export const skinById = (id) => SKINS.find((s) => s.id === id) || SKINS[0];
