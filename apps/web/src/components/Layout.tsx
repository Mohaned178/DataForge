import { Link, NavLink, Outlet } from 'react-router';

export function Layout() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="wrap site-header__inner">
          <Link to="/" className="brand">
            DataForge
          </Link>
          <nav aria-label="Main">
            <NavLink to="/executions">Executions</NavLink>
            <NavLink to="/runs">Runs</NavLink>
            <NavLink to="/scenarios">Scenarios</NavLink>
            <NavLink to="/chaos-profiles">Chaos profiles</NavLink>
          </nav>
        </div>
      </header>
      <main id="main" className="wrap">
        <Outlet />
      </main>
    </>
  );
}
