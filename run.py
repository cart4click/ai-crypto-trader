"""Run the app:  python run.py   (then open http://127.0.0.1:8000)"""
import uvicorn

from app.config import settings

if __name__ == "__main__":
    uvicorn.run("app.main:app", host=settings.app_host, port=settings.app_port, reload=False)
