import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { DefinitionsPage } from './pages/DefinitionsPage';
import { RefinePage } from './pages/RefinePage';
import { InstancesPage } from './pages/InstancesPage';
import { InstanceDetailPage } from './pages/InstanceDetailPage';
import { InboxPage } from './pages/InboxPage';
import { DashboardsPage } from './pages/DashboardsPage';
import { SystemPage } from './pages/SystemPage';

const NAV = [
  ['/definitions', 'Definitions'],
  ['/instances', 'Instances'],
  ['/inbox', 'Inbox'],
  ['/dashboards', 'Dashboards'],
  ['/system', 'System'],
] as const;

export function App() {
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">Flow Fabric</div>
        {NAV.map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
            {label}
          </NavLink>
        ))}
      </nav>
      <main className="content">
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
