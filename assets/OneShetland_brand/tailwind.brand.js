/** OneShetland — Tailwind theme fragment. Merge into tailwind.config.js. */
module.exports = {
  theme: {
    extend: {
      colors: {
        os: {
          'navy': { DEFAULT: '#17395B', light: '#2E5A85', dark: '#0F2740' },
          'teal': { DEFAULT: '#2A8E82', light: '#3FB0A2', dark: '#1D6B62' },
          'amber': { DEFAULT: '#EFAE4A', light: '#F7C878', dark: '#C88C2E' },
          'coral': { DEFAULT: '#E1604C', light: '#EC8271', dark: '#B84634' },
          'purple': { DEFAULT: '#A45FAE', light: '#BC81C4', dark: '#7E458A' },
          'indigo': { DEFAULT: '#5C5FA0', light: '#7C7FBB', dark: '#43467A' },
          'paper': '#F4F3F0',
          'haar': '#E4E3DE',
          'stane': '#9A9A96',
          'peat': '#4A4A48',
          'ink': '#101112',
          'white': '#FFFFFF',
        },
      },
      fontFamily: {
        heading: ['Barlow Condensed', 'system-ui', 'sans-serif'],
        body: ['Barlow', 'system-ui', 'sans-serif'],
      },
      borderRadius: { os: '4px' },
      boxShadow: {
        'os-sm': '0 1px 2px rgba(16,17,18,0.10)',
        'os-md': '0 3px 10px rgba(16,17,18,0.12)',
        'os-lg': '0 12px 32px rgba(16,17,18,0.18)',
      },
    },
  },
};
