// Run with: claude plugin test plugins/duet
import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PANE = {
  plugin: 'duet',
  component: 'Pane',
  requestId: 'duet',
  props: {
    title: 'Duet Workbench',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const JOB = {
  id: 'task-1',
  kind: 'task',
  status: 'running',
  title: 'Fix login',
  model: 'gpt-6-luna',
  effort: null,
  write: false,
  elapsed: '3s',
  progressPreview: ['reading files'],
  tokens: 12345,
}

// Stands for the runtime: answers by subcommand and records every call.
const fakeRuntime = (on: Parameters<TestBody>[1], override: Record<string, unknown> = {}) => {
  const calls: { args: string[]; stdin?: string }[] = []
  on('session.root', () => ({ value: '/proj' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('process.run', (_, e) => {
    const args = e.argv.slice(2)
    calls.push({ args: [...args], stdin: e.init?.stdin })
    const access = args[args.indexOf('--access') + 1]
    const answers: Record<string, unknown> = {
      status: { running: [JOB], latestFinished: null, recent: [] },
      // As the runtime: Auto access gives write to a task that changes files.
      shape: { prompt: `Goal: ${e.init?.stdin}\n\nDone when: it works.`, write: access === 'write' || (access === 'auto' && /fix/.test(e.init?.stdin ?? '')) },
      task: { jobId: 'task-1' },
      limits: { limits: [{ label: 'Session', leftPercent: 92, resetsAt: null }, { label: 'Week', leftPercent: 8, resetsAt: null }] },
    }
    Object.assign(answers, override)
    const stdout = args.includes('--json') ? JSON.stringify(answers[args[0] ?? ''] ?? {}) : `ran ${args[0]}`

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return calls
}

test('a task is composed, previewed and sent on stdin, never in argv', async ($, on) => {
  const calls = fakeRuntime(on)
  on('model.complete', () => ({ value: { isAnswered: true, text: ' Fix the\nlogin ', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    calls.length = 0
    const ui = await $.ui.mount({ ...PANE, surface })
    // Shape prompt is off until asked for; the form outlives the mount, so it is ticked once.
    if (surface === 'terminal') {
      await ui.press({ key: 'shape' })
    }

    await ui.input({ key: 'task', text: 'fix the login; rm -rf /', kind: 'change' })
    await ui.press({ key: 'preview' })
    const shaped = String((await ui.find({ type: 'Input', key: 'prompt' }))?.props.value)
    expect(shaped).toMatch(/^Goal: fix the login/)
    // The preview stands in for the task field: one field, one Send button.
    expect(await ui.find({ type: 'Input', key: 'task' })).toBeUndefined()
    expect(await ui.findAll({ type: 'Button', text: /send/i })).toHaveLength(1)

    await ui.press({ key: 'delegate' })
    const task = calls.find(call => call.args[0] === 'task')
    expect(task?.stdin).toMatch(/^Goal: fix the login; rm -rf \//)
    // Access is Auto by default: "fix …" changes files, so the run gets write access.
    // With Shape prompt on, the run also gets a short name, passed as one argv value.
    expect(task?.args).toEqual(['task', '--background', '--write', '--title', 'Fix the login', '--json', '--cwd', '/proj'])

    // The job shows with its last activity line and can be cancelled.
    expect((await ui.find({ type: 'Text', text: /Fix login/ }))?.text).toBe('Fix login')
    await ui.press({ key: 'task-1:cancel' })
    expect(calls.some(call => call.args.join(' ') === 'cancel task-1 --cwd /proj')).toBe(true)
    await ui.unmount()
  }
})

test('Continue is a tick box that can be undone and leaves access on Auto; History shows the thread', async ($, on) => {
  const calls = fakeRuntime(on, {
    status: {
      running: [],
      latestFinished: { ...JOB, id: 'task-2', status: 'completed', write: true, threadId: 'th-1' },
      recent: [{ ...JOB, id: 'task-1', status: 'completed', threadId: 'th-1' }],
    },
  })
  const filled: unknown[] = []
  on('prompt.fill', (_, e) => (filled.push({ text: e.text, mode: e.mode }), { isFilled: true }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ key: 'resume' })).toBeUndefined()
  await ui.press({ key: 'task-2:continue' })
  expect((await ui.find({ type: 'Button', key: 'resume' }))?.text).toBe('☑ Same Codex thread')
  // The earlier run wrote, yet a question in the same thread runs read-only.
  expect((await ui.find({ type: 'Select', key: 'access' }))?.props.value).toBe('auto')
  await ui.input({ key: 'task', text: 'why does login fail' })
  expect(calls.find(call => call.args[0] === 'task')?.args.join(' ')).toBe('task --background --resume-last --json --cwd /proj')

  // Unticked, the tick box stays and the run is a fresh thread.
  calls.length = 0
  await ui.press({ key: 'task-2:continue' })
  await ui.press({ key: 'resume' })
  expect((await ui.find({ type: 'Button', key: 'resume' }))?.text).toBe('☐ Same Codex thread')
  expect(await ui.find({ text: /Fresh thread/ })).toBeDefined()
  await ui.input({ key: 'task', text: 'why does login fail' })
  expect(calls.find(call => call.args[0] === 'task')?.args).not.toContain('--resume-last')

  // A reference to the run goes into Claude's prompt box, unsent.
  await ui.press({ key: 'task-2:ask' })
  expect(filled).toEqual([{ text: 'About Codex run task-2 (“Fix login”): ', mode: 'append' }])

  // Deleting asks first; Confirm removes the run.
  await ui.press({ key: 'task-1:forget' })
  expect((await ui.find({ type: 'Text', text: /^Delete “Fix login”\?$/ }))?.text).toBe('Delete “Fix login”?')
  expect(calls.some(call => call.args[0] === 'forget')).toBe(false)
  await ui.press({ key: 'confirm' })
  expect(calls.some(call => call.args.join(' ') === 'forget task-1 --cwd /proj')).toBe(true)
  // The output card can send the pane back to the top. (The scroll itself is not checked here:
  // the test's mounted pane is not a scrollable site.)
  expect(await ui.find({ type: 'Button', key: 'out-top' })).toBeDefined()

  // Two runs share the thread, so its whole conversation can be opened.
  await ui.press({ key: 'task-2:history' })
  expect(calls.some(call => call.args.join(' ') === 'history task-2 --cwd /proj')).toBe(true)
  await ui.unmount()
})

test('minimized on the desktop the pane is a glance with no controls', async ($, on) => {
  fakeRuntime(on)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget', anchoredEdges: [] }, surface: 'desktop' })

  expect((await ui.find({ type: 'Text', text: /rules mirror/ }))?.text).toMatch(/rules mirror/)
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(await ui.find({ type: 'Input' })).toBeUndefined()
  await ui.unmount()
})

test('Enter in the task field sends it; Refresh re-reads the header', async ($, on) => {
  const calls = fakeRuntime(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'task', text: 'why does login fail' })
  const task = calls.find(call => call.args[0] === 'task')
  // Shape prompt is off by default: the task goes as written and no name is made for it.
  expect(task?.stdin).toBe('why does login fail')
  expect(task?.args).not.toContain('--title')
  expect(calls.find(call => call.args[0] === 'shape')?.args.join(' ')).toMatch(/--type auto --access auto/)
  // A question stays read-only under Auto.
  expect(task?.args).not.toContain('--write')

  // Read-only chosen by hand holds even for a task that would change files.
  calls.length = 0
  await ui.select({ key: 'access', value: 'read' })
  await ui.input({ key: 'task', text: 'fix the login' })
  // Nothing to shape and nothing to decide: the runtime is not asked.
  expect(calls.find(call => call.args[0] === 'shape')).toBeUndefined()
  expect(calls.find(call => call.args[0] === 'task')?.args).not.toContain('--write')

  // A run that is still going has no Result button: it has nothing to show yet.
  expect(await ui.find({ type: 'Button', key: 'task-1:result' })).toBeUndefined()

  expect(calls.some(call => call.args[0] === 'setup')).toBe(false)
  await ui.press({ key: 'refresh' })
  expect(calls.some(call => call.args[0] === 'setup')).toBe(true)

  // Limits left as bars with a percent; tokens spent on the run's row.
  expect(await ui.find({ text: /Session · 92% left/ })).toBeDefined()
  expect(await ui.find({ text: /Week · 8% left/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /12\.3k tokens/ }))?.text).toMatch(/running .* 12\.3k tokens/)
  expect(await ui.find({ type: 'Button', text: /Delegate|Mini/ })).toBeUndefined()
  await ui.unmount()
})

test('the logo is a picture in the terminal and a vector in the desktop app', async ($, on) => {
  fakeRuntime(on)
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Image', key: 'logo' })).toBeDefined()
  // The desktop table also names Image: picking by `'Image' in ui` drew nothing there.
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desk.find({ type: 'Svg' }))?.props.alt).toBe('Duet Workbench')
  expect(await desk.find({ type: 'Image' })).toBeUndefined()
})

test('the Codex runs box folds to its header and keeps a running count', async ($, on) => {
  fakeRuntime(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'task-1:cancel' })).toBeDefined()

  await ui.press({ key: 'runs-fold' })
  expect(await ui.find({ type: 'Button', key: 'task-1:cancel' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'runs-fold' }))?.text).toBe('▸ Codex runs · 1')
  expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()

  await ui.press({ key: 'runs-fold' })
  expect(await ui.find({ type: 'Button', key: 'task-1:cancel' })).toBeDefined()
})

test('Result shows on a finished run, in its own card that closes', async ($, on) => {
  fakeRuntime(on, { status: { running: [], latestFinished: null, recent: [{ ...JOB, status: 'completed' }] } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  await ui.press({ key: 'task-1:result' })
  expect((await ui.find({ type: 'Text', text: /^Result task-1/ }))?.text).toBe('Result task-1')
  await ui.press({ key: 'out-close' })
  expect(await ui.find({ type: 'Text', text: /^Result task-1/ })).toBeUndefined()
  await ui.unmount()
})
