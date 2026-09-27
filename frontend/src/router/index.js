import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '../views/LoginView.vue'
import LiveCctv from '../views/LiveCctv.vue'
import CameraFinder from '../views/CameraFinder.vue'

const routes = [
  { path: '/login', component: LoginView },
  { path: '/', component: LiveCctv },
  { path: '/finder', component: CameraFinder }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router