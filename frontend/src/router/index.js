import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '../views/LoginView.vue'
import LiveCctv from '../views/LiveCctv.vue'
import CameraFinder from '../views/CameraFinder.vue'
import CameraManage from '../views/CameraManage.vue'
import CameraEdit from '../views/CameraEdit.vue'
import SettingsView from '../views/SettingsView.vue'
import PasswordView from '../views/PasswordView.vue'

const routes = [
  { path: '/login', component: LoginView },
  { path: '/', component: LiveCctv },
  { path: '/settings', component: SettingsView },
  { path: '/settings/password', component: PasswordView },
  { path: '/cameras', component: CameraManage },
  { path: '/cameras/add', component: CameraFinder },
  { path: '/cameras/:index/edit', component: CameraEdit },
  { path: '/finder', redirect: '/cameras/add' }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
