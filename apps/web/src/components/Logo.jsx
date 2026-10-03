import { motion } from 'framer-motion';

/** Buddo's mascot mark: a friendly rounded screen with blinking eyes. */
export default function Logo({ size = 28, animated = true, thinking = false }) {
  const id = 'lg' + size;
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      initial={animated ? { scale: 0.6, opacity: 0, rotate: -12 } : false}
      animate={{ scale: 1, opacity: 1, rotate: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 18 }}
      className={thinking ? 'logo logo-busy' : 'logo'}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--logo-1, var(--accent))" />
          <stop offset="1" stopColor="var(--logo-2, var(--accent-2))" />
        </linearGradient>
      </defs>
      <rect x="6" y="10" width="52" height="44" rx="15" fill={`url(#${id})`} />
      <rect x="6" y="10" width="52" height="44" rx="15" fill="white" opacity="0.08" />
      <g className="logo-eyes">
        <rect x="20" y="25" width="7" height="13" rx="3.5" fill="#0b0b10" />
        <rect x="37" y="25" width="7" height="13" rx="3.5" fill="#0b0b10" />
      </g>
      <path d="M27 44 q5 4 10 0" stroke="#0b0b10" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.8" />
    </motion.svg>
  );
}
