import { useEffect, useState, type ComponentType, type SVGProps } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { DefinitionsPage } from './pages/DefinitionsPage';
import { RefinePage } from './pages/RefinePage';
import { InstancesPage } from './pages/InstancesPage';
import { InstanceDetailPage } from './pages/InstanceDetailPage';
import { InboxPage } from './pages/InboxPage';
import { DashboardsPage } from './pages/DashboardsPage';
import { SystemPage } from './pages/SystemPage';
import {
  DashboardsIcon,
  DefinitionsIcon,
  InstancesIcon,
  InboxIcon,
  SystemIcon,
  ChevronIcon,
} from './components/icons';

type NavItem = readonly [to: string, label: string, Icon: ComponentType<SVGProps<SVGSVGElement>>];

const NAV: readonly NavItem[] = [
  ['/dashboards', 'Dashboards', DashboardsIcon],
  ['/definitions', 'Definitions', DefinitionsIcon],
  ['/instances', 'Instances', InstancesIcon],
  ['/inbox', 'Inbox', InboxIcon],
  ['/system', 'System', SystemIcon],
];

const COLLAPSE_KEY = 'ff.rail.collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export function App() {
  const [collapsed, setCollapsed] = useState(readCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* storage unavailable (private mode); collapse still works in-session */
    }
  }, [collapsed]);

  return (
    <div className="shell">
      <a href="#main-content" className="skip-link">Skip to main content</a>
      <nav className={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Primary">
        <div className="rail-head">
          <img
            className="rail-mark"
            src="/flow-fabric-icon-192.png"
            width={34}
            height={34}
            alt="Flow Fabric"
          />
          <div className="rail-wordmark">
            <div className="brand">Flow Fabric</div>
            <div className="tagline">Control Plane</div>
          </div>
          <button
            type="button"
            className="rail-toggle"
            aria-expanded={!collapsed}
            aria-controls="primary-nav"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronIcon className="rail-toggle-ico" />
            <span className="sr-only">{collapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span>
          </button>
        </div>
        <div className="rail-nav" id="primary-nav">
          {NAV.map(([to, label, Icon]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => (isActive ? 'active' : '')}
              title={collapsed ? label : undefined}
            >
              <span className="nav-ico"><Icon /></span>
              <span className="nav-label">{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
      <main className="content" id="main-content">
        <Routes>
          <Route path="/" element={<Navigate to="/definitions" replace />} />
          <Route path="/definitions" element={<DefinitionsPage />} />
          <Route path="/definitions/:id/refine" element={<RefinePage />} />
          <Route path="/instances" element={<InstancesPage />} />
          <Route path="/instances/:id" element={<InstanceDetailPage />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/dashboards" element={<DashboardsPage />} />
          <Route path="/system" element={<SystemPage />} />
        </Routes>
      </main>
    </div>
  );
}
