import { Route, Routes } from 'react-router'
import { AcceptLink, Login, RequireAuth } from './pages/Auth'
import { Admin } from './pages/Admin'
import { Connect } from './pages/Connect'
import { History } from './pages/History'
import { Library } from './pages/Library'
import { Pronunciation } from './pages/Pronunciation'
import { RadioPage } from './pages/Radio'
import { Security } from './pages/Security'

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/invite/:token" element={<AcceptLink />} />
      <Route path="/reset/:token" element={<AcceptLink />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <RadioPage />
          </RequireAuth>
        }
      />
      <Route
        path="/library"
        element={
          <RequireAuth>
            <Library />
          </RequireAuth>
        }
      />
      <Route
        path="/connect"
        element={
          <RequireAuth>
            <Connect />
          </RequireAuth>
        }
      />
      <Route
        path="/history"
        element={
          <RequireAuth>
            <History />
          </RequireAuth>
        }
      />
      <Route
        path="/pronunciation"
        element={
          <RequireAuth>
            <Pronunciation />
          </RequireAuth>
        }
      />
      <Route
        path="/security"
        element={
          <RequireAuth>
            <Security />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth admin>
            <Admin />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Login />} />
    </Routes>
  )
}
