import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
  // pdfkit reads its font metric files from disk at runtime.
  serverExternalPackages: ['pdfkit'],
}

export default nextConfig
