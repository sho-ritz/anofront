import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Detected {
  framework: string
  dir: string
  build: string
  notes: string[]
}

function pm(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun'
  return 'npm'
}

/** Works out the build command and output directory from package.json. */
export function detect(cwd: string): Detected {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) return { framework: 'static', dir: '.', build: '', notes: ['No package.json: the current folder is published as is.'] }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const build = pkg.scripts?.build ? `${pm(cwd)} run build` : ''
  const notes: string[] = []
  if (deps.next) {
    const cfgFile = ['next.config.ts', 'next.config.mjs', 'next.config.js'].map((f) => join(cwd, f)).find(existsSync)
    const src = cfgFile ? readFileSync(cfgFile, 'utf8') : ''
    if (!/output\s*:\s*['"]export['"]/.test(src))
      notes.push(`Next.js needs a static export: add  output: 'export'  to ${cfgFile ? cfgFile.split('/').pop() : 'next.config'}. Server features (SSR, API routes, middleware) do not run on nsite.`)
    return { framework: 'next', dir: 'out', build, notes }
  }
  if (deps['@sveltejs/kit']) {
    if (!deps['@sveltejs/adapter-static']) notes.push('SvelteKit needs @sveltejs/adapter-static (with fallback: "404.html" for SPA mode).')
    return { framework: 'sveltekit', dir: 'build', build, notes }
  }
  if (deps.astro) return { framework: 'astro', dir: 'dist', build, notes }
  if (deps['react-scripts']) return { framework: 'create-react-app', dir: 'build', build, notes }
  if (deps.vite) return { framework: 'vite', dir: 'dist', build, notes }
  return { framework: 'unknown', dir: 'dist', build, notes: ['Could not detect the framework; set "dir" in anofront.json if the build output is elsewhere.'] }
}
