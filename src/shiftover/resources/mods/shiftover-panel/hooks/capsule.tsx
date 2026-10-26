import type { ClientPointerEvent, ClientSurface, Color, RenderElement, TextProps } from 'claude-code'

// The pane's clickable capsules (a chat with its delegate rows, a job, an
// agent), drawn by the surface itself rather than as Buttons: a Button fills
// under the pointer, this draws nothing but its border differently. The
// hooks module hands it fitted lines, and new ones for every spinner or
// blink frame; it keeps no clock.

// MARK: - Props

// One run of a line: its text and how it is drawn.
export type CapsuleSeg = { text: string; color?: Color; dim?: boolean; weight?: TextProps['weight'] }

// What the pane hands over for one chat, job or agent: plain data, each line
// already fitted to the capsule.
export type CapsuleProps = {
  // The capsule's own key (`chat:<id>`, `job:<id>`, `agent:<id>`): what a
  // click on its lines posts.
  key: string
  // The capsule's columns, its border included, and the cells between the
  // border and the lines on either side.
  width: number
  padding: number
  // The border's color at rest; hovering a part a click acts on draws it `text`.
  border: Color
  // Whether a click on the capsule's own lines acts: not the current chat's.
  isPressable: boolean
  lines: CapsuleSeg[][]
  // Rows under the lines, each its own target: a delegate's `follow:<id>`.
  rows: { key: string; line: CapsuleSeg[] }[]
}

// MARK: - State

// Where the pointer rests over a part a click acts on, and which part a left
// button went down on: what its release acts on, if released there.
type Hover = { at: { x: number; y: number } | null; pressed: string | null }

const REST: Hover = { at: null, pressed: null }

// MARK: - Targets

// The part under a cell of the region: a row under the lines is its own; the
// border and the lines are the capsule's, when a click on them acts at all.
function targetAt(props: CapsuleProps, x: number, y: number): string | null {
  const height = props.lines.length + props.rows.length + 2
  if (x < 0 || x >= props.width || y < 0 || y >= height) return null
  return props.rows[y - 1 - props.lines.length]?.key ?? (props.isPressable ? props.key : null)
}

// MARK: - Capsule

export default function Capsule(props: CapsuleProps, surface: ClientSurface<Hover>): RenderElement {
  const { Box, Text } = surface.elements
  // The listener set on this call reads and writes this, so a release in
  // the same frame as its press finds it.
  let held = surface.state ?? REST
  const set = (next: Hover): void => {
    held = next
    surface.setState(next)
  }
  // Set again on every call, so it hit-tests the lines it drew.
  surface.onPointer((event: ClientPointerEvent) => {
    const target = targetAt(props, event.x, event.y)
    if (event.type === 'enter' || event.type === 'move' || event.type === 'leave') {
      const next = event.type === 'leave' ? null : target
      // Only a change of part redraws.
      if (next !== (held.at === null ? null : targetAt(props, held.at.x, held.at.y))) {
        set({ ...held, at: next === null ? null : { x: event.x, y: event.y } })
      }
      return
    }
    // A right or middle click does nothing.
    if (event.button !== 'left') return
    if (event.type === 'down') {
      if (held.pressed !== target) set({ ...held, pressed: target })
      return
    }
    if (target !== null && target === held.pressed) surface.post({ target })
    if (held.pressed !== null) set({ ...held, pressed: null })
  })
  const isLit = held.at !== null && targetAt(props, held.at.x, held.at.y) !== null
  // A run keeps its color, dimness and weight, the same at rest and hovered.
  const run = (seg: CapsuleSeg) => seg.color === undefined && seg.dim !== true && seg.weight === undefined ? seg.text
    : <Text {...(seg.color === undefined ? {} : { color: seg.color })} {...(seg.dim === true ? { dimColor: true } : {})}
      {...(seg.weight === undefined ? {} : { weight: seg.weight })}>{seg.text}</Text>
  const draw = (line: CapsuleSeg[]) => (
    <Text wrap="truncate-end" mono>
      {(line.length === 0 ? [{ text: ' ' }] : line).filter(seg => seg.text !== '').map(run)}
    </Text>
  )
  // A row keeps its key on a Box of its own: one row of the region each.
  return (
    <Box key={`capsule:${props.key}`} width={props.width} flexShrink={0} flexDirection="column" borderStyle="round"
      borderColor={isLit ? 'text' : props.border} paddingX={props.padding}>
      {props.lines.map(line => draw(line))}
      {props.rows.map(row => <Box key={row.key} flexDirection="column">{draw(row.line)}</Box>)}
    </Box>
  )
}
