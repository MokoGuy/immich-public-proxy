import { sourceLabel, sourceUrl } from '../source'

/**
 * The AGPL section 13 offer, rendered on every page a visitor can reach.
 *
 * Deliberately unobtrusive but not hidden: section 13 asks for a "prominent"
 * opportunity to receive the Corresponding Source, which a footer link
 * satisfies and a link buried in a repository does not. `rel="noopener"`
 * because it leaves the site; no `nofollow` - being findable is the point.
 */
export function SourceFooter () {
  return (
    <footer id="source-offer">
      <a href={sourceUrl()} rel="noopener" target="_blank">{sourceLabel()}</a>
    </footer>
  )
}
