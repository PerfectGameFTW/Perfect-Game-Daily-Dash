import React from 'react';

export default function PerfectGameLogo({ className = "w-32 h-32" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 80"
      className={className}
    >
      {/* Logo Background */}
      <rect x="0" y="0" width="200" height="80" rx="10" fill="#182d54" />
      
      {/* Baseball */}
      <circle cx="40" cy="40" r="24" fill="#ffffff" />
      <path 
        d="M40 16 C 31 16, 23 22, 21 31 C 36 25, 52 36, 49 53 C 58 50, 64 42, 64 32 C 64 23, 53 16, 40 16" 
        fill="#e12a3c" 
      />
      <path 
        d="M21 49 C 24 58, 32 64, 41 64 C 50 64, 58 58, 61 49 C 46 55, 30 44, 33 27 C 24 30, 18 38, 18 48 C 18 48.5, 21 49, 21 49" 
        fill="#e12a3c" 
      />
      <path 
        d="M18 32 C 22 22, 30 16, 40 16 M64 48 C 60 58, 52 64, 42 64" 
        stroke="#222222" 
        strokeWidth="1" 
        fill="none" 
      />
      <path 
        d="M29 22 C 34 34, 46 40, 58 36 M29 58 C 34 46, 46 40, 58 44" 
        stroke="#222222" 
        strokeWidth="1" 
        fill="none" 
      />
      
      {/* Perfect Game Text */}
      <text x="80" y="35" fontFamily="Arial" fontSize="18" fontWeight="bold" fill="#ffffff">PERFECT</text>
      <text x="80" y="55" fontFamily="Arial" fontSize="18" fontWeight="bold" fill="#ffffff">GAME</text>
      
      {/* Analytics Text */}
      <text x="80" y="70" fontFamily="Arial" fontSize="9" fill="#e12a3c">ANALYTICS DASHBOARD</text>
    </svg>
  );
}