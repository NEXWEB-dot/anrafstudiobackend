import admin from '../../../admin/index.js';
export const onRequest = ({request,env}) => admin.fetch(request,env);
