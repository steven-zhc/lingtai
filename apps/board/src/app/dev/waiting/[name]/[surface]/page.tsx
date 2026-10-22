import { notFound } from 'next/navigation'

import { Card } from '@/app/page.tsx'
import { TaskBody } from '@/app/task/[id]/page.tsx'

import { CASES, PREVIEW_NOW, preview, type CaseName } from '../../../../../../test/visual-waiting.ts'

export default async function WaitingPreview({ params }: { params: Promise<{ name: string; surface: string }> }) {
  if (process.env.NODE_ENV !== 'development') notFound()
  const { name, surface } = await params
  if (!Object.hasOwn(CASES, name) || (surface !== 'card' && surface !== 'task')) notFound()
  const { card, task } = await preview(name as CaseName)
  return (
    <div inert style={surface === 'card' ? { width: '100%', maxWidth: 440, padding: 16 } : undefined}>
      {surface === 'card' ? (
        <Card card={card} showProject={false} issue={null} paused={false} />
      ) : (
        <TaskBody task={task} now={PREVIEW_NOW} />
      )}
    </div>
  )
}
