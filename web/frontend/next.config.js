/** @type {import('next').NextConfig} */
const nextConfig = {
  // The backend API URL — set NEXT_PUBLIC_API_URL in Vercel env vars
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001',
  },
}

module.exports = nextConfig
