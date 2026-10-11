import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'

const modes = [
  {
    to: '/study/rotation',
    eyebrow: 'Clinical year',
    title: 'Rotation mode',
    body: 'Pick one of the seven core End of Rotation exams. See which blueprint areas have practice cases, what review is due, and what to practice next.',
  },
  {
    to: '/study/pance',
    eyebrow: 'Board prep',
    title: 'PANCE mode',
    body: 'Study by the official PANCE content and task weights, and jump to cases for any system and task pair.',
  },
  {
    to: '/study/mixed',
    eyebrow: 'Interleaved',
    title: 'Mixed mode',
    body: 'A queue that mixes systems and tasks, ordered by your own misses weighted by how much the blueprint counts them.',
  },
  {
    to: '/study/sprint',
    eyebrow: 'Short drill',
    title: 'Differential sprint',
    body: 'Read the key findings from a case you have finished and pick the diagnosis that fits best among similar presentations.',
  },
]

export function StudyHome() {
  return (
    <>
      <section className="page-intro">
        <div>
          <p className="eyebrow">STUDY MODES</p>
          <h1>Practice by exam blueprint.</h1>
          <p className="lede">
            Organize practice around the PANCE and End of Rotation blueprints. Every view shows what exists today, including areas with no cases yet.
          </p>
        </div>
      </section>
      <div className="case-grid study-modes">
        {modes.map((m) => (
          <article className="case-card" key={m.to}>
            <div className="case-card-top">
              <span className="tag">{m.eyebrow}</span>
            </div>
            <h2>{m.title}</h2>
            <p>{m.body}</p>
            <div className="case-footer">
              <span />
              <Link className="button button-small" to={m.to}>
                Open <ArrowRight size={15} aria-hidden="true" />
              </Link>
            </div>
          </article>
        ))}
      </div>
      <section className="study-notice" aria-label="What is not offered">
        <h2>No full-length exam simulations yet</h2>
        <p>
          PA-Sim does not offer full-length EOR, PACKRAT, End of Curriculum or PANCE simulations. The case bank is far too small to match any official exam structure without repeating
          cases, and no case has yet been reviewed against a blueprint. Coverage counts on each page show exactly what exists.
        </p>
      </section>
    </>
  )
}
