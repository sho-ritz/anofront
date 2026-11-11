import { createInterface } from 'node:readline'

export const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY

export function ask(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    if (opts.hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream }
      out._writeToOutput = (s: string) => {
        if (s.startsWith(question)) out.output.write(s)
      }
    }
    rl.question(question, (a) => {
      rl.close()
      if (opts.hidden) process.stdout.write('\n')
      resolve(a.trim())
    })
  })
}

export async function confirm(question: string): Promise<boolean> {
  const a = (await ask(`${question} [y/N] `)).toLowerCase()
  return a === 'y' || a === 'yes'
}
