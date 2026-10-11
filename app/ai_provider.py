"""Multi-AI provider manager with automatic failover and performance tracking.

Supports multiple OpenAI-compatible API providers with automatic failover,
performance monitoring, and load balancing across providers.
"""
import asyncio
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional
from enum import Enum

import httpx

log = logging.getLogger("ai_provider")

# Global provider manager instance
_global_provider_manager = None

def get_global_provider_manager():
    global _global_provider_manager
    if _global_provider_manager is None:
        _global_provider_manager = AIProviderManager()
    return _global_provider_manager


class ProviderStatus(Enum):
    """Status of AI providers."""
    UNKNOWN = "unknown"
    HEALTHY = "healthy"
    SLOW = "slow"
    ERROR = "error"
    RATE_LIMITED = "rate_limited"


@dataclass
class AIProvider:
    """Represents a single AI provider configuration."""
    name: str
    base_url: str
    api_key: str
    model: str
    status: ProviderStatus = ProviderStatus.UNKNOWN
    response_time_ms: float = 0.0
    success_count: int = 0
    failure_count: int = 0
    last_check: float = 0.0
    error_message: str = ""


@dataclass
class ProviderStats:
    """Performance statistics for a provider."""
    avg_response_time: float = 0.0
    success_rate: float = 0.0
    total_requests: int = 0
    recent_response_times: List[float] = field(default_factory=list)


class AIProviderManager:
    """Manages multiple AI providers with automatic failover."""
    
    def __init__(self):
        self.providers: Dict[str, AIProvider] = {}
        self.stats: Dict[str, ProviderStats] = {}
        self._current_provider: Optional[str] = None
        self._lock = asyncio.Lock()
        self._client: Optional[httpx.AsyncClient] = None
        self._load_providers_from_env()
        # Don't auto-select provider here - let health check determine the best one
        
    def _load_providers_from_env(self):
        """Load AI providers from environment variables."""
        provider_configs_found = False
        for i in range(1, 10):  # Support up to 10 providers
            env_var = f"AI_PROVIDER_{i}"
            config = os.getenv(env_var, "")
            if not config:
                continue

            provider_configs_found = True
                
            try:
                parts = config.split("|")
                if len(parts) >= 4:
                    name, base_url, api_key, model = parts[0], parts[1], parts[2], parts[3]
                elif len(parts) >= 2 and parts[0].startswith("gsk_"):
                    api_key, model = parts[0], parts[1]
                    name = f"groq-{model.rsplit('/', 1)[-1]}"
                    base_url = "https://api.groq.com/openai/v1"
                else:
                    log.warning(f"Invalid AI provider config: {env_var}")
                    continue
                    
                provider = AIProvider(
                    name=name,
                    base_url=base_url.rstrip("/"),
                    api_key=api_key,
                    model=model
                )
                self.providers[name] = provider
                self.stats[name] = ProviderStats()
                
                # Only show as "loaded" if there's an actual API key (not placeholder)
                if api_key and not api_key.startswith("YOUR_"):
                    log.info(f"Loaded AI provider: {name} ({model})")
                else:
                    log.info(f"Configured AI provider: {name} ({model}) - no API key")
                
            except Exception as e:
                log.warning(f"Failed to parse AI provider {env_var}: {e}")

        # Keep the original single-provider .env format working.
        if "z.ai" not in self.providers:
            api_key = os.getenv("AI_API_KEY", "").strip()
            if api_key:
                name = "z.ai"
                model = os.getenv("AI_MODEL", "gpt-4o-mini").strip()
                base_url = os.getenv("AI_BASE_URL", "https://api.openai.com/v1").strip().rstrip("/")
                self.providers[name] = AIProvider(
                    name=name,
                    base_url=base_url,
                    api_key=api_key,
                    model=model,
                )
                self.stats[name] = ProviderStats()
                log.info(f"Loaded legacy AI provider: {name} ({model})")
    
    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30)
        return self._client
    
    async def close(self):
        """Clean up resources."""
        if self._client:
            await self._client.aclose()
            self._client = None
    
    async def _test_provider(self, provider: AIProvider) -> bool:
        """Test if a provider is responsive."""
        # Skip testing providers without valid API keys
        if not provider.api_key or provider.api_key.startswith("YOUR_"):
            provider.status = ProviderStatus.UNKNOWN
            provider.error_message = "No valid API key"
            return False
            
        try:
            client = await self._get_client()
            start = time.time()
            
            # Simple test request
            response = await client.post(
                f"{provider.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {provider.api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": provider.model,
                    "messages": [{"role": "user", "content": "test"}],
                    "max_tokens": 10
                },
                timeout=10
            )
            
            response_time = (time.time() - start) * 1000
            
            if response.status_code == 200:
                provider.status = ProviderStatus.HEALTHY
                provider.response_time_ms = response_time
                provider.success_count += 1
                provider.last_check = time.time()
                provider.error_message = ""
                return True
            elif response.status_code == 429:
                provider.status = ProviderStatus.RATE_LIMITED
                provider.failure_count += 1
                provider.last_check = time.time()
                provider.error_message = "Rate limited"
                return False
            else:
                provider.status = ProviderStatus.ERROR
                provider.failure_count += 1
                provider.last_check = time.time()
                provider.error_message = f"HTTP {response.status_code}"
                return False
                
        except asyncio.TimeoutError:
            provider.status = ProviderStatus.SLOW
            provider.failure_count += 1
            provider.last_check = time.time()
            provider.error_message = "Timeout"
            return False
        except Exception as e:
            provider.status = ProviderStatus.ERROR
            provider.failure_count += 1
            provider.last_check = time.time()
            provider.error_message = str(e)
            return False
            provider.failure_count += 1
            provider.last_check = time.time()
            provider.error_message = str(e)[:100]
            return False
    
    async def health_check(self):
        """Check health of all providers and select the best one."""
        async with self._lock:
            # Test all providers with valid API keys
            for provider in self.providers.values():
                # Only test providers with valid API keys
                if provider.api_key and not provider.api_key.startswith("YOUR_"):
                    await self._test_provider(provider)
                    log.info(f"Provider {provider.name} status: {provider.status.value}")
                else:
                    provider.status = ProviderStatus.UNKNOWN
                    provider.error_message = "No valid API key"
                self._update_stats(provider)
            
            # Select the best provider after testing
            best_provider = None
            best_score = -1
            
            for provider in self.providers.values():
                # Skip providers without valid API keys
                if not provider.api_key or provider.api_key.startswith("YOUR_"):
                    continue
                
                # Score: prioritize healthy, then by performance
                if provider.status == ProviderStatus.HEALTHY:
                    provider_stats = self.stats[provider.name]
                    score = provider_stats.success_rate * 1000 - provider_stats.avg_response_time
                    log.info(f"Provider {provider.name} healthy with score: {score}")
                    if score > best_score:
                        best_score = score
                        best_provider = provider
                elif provider.status == ProviderStatus.RATE_LIMITED:
                    # Still consider rate-limited providers as fallback if no healthy ones
                    if best_provider is None:
                        best_provider = provider
                        log.info(f"Provider {provider.name} rate-limited, using as fallback")
            
            if best_provider:
                self._current_provider = best_provider.name
                log.info(f"Selected AI provider: {best_provider.name} ({best_provider.model})")
            elif self.providers:
                # Fallback to first provider if no healthy ones found
                first_provider = next(iter(self.providers.values()))
                if first_provider.api_key and not first_provider.api_key.startswith("YOUR_"):
                    self._current_provider = first_provider.name
                    log.warning(f"Using fallback provider: {first_provider.name} (no healthy providers available)")
    
    def _update_stats(self, provider: AIProvider):
        """Update performance statistics for a provider."""
        provider_stats = self.stats[provider.name]
        provider_stats.total_requests = provider.success_count + provider.failure_count
        
        if provider_stats.total_requests > 0:
            provider_stats.success_rate = provider.success_count / provider_stats.total_requests
        
        if provider.response_time_ms > 0:
            provider_stats.recent_response_times.append(provider.response_time_ms)
            # Keep only last 10 response times
            if len(provider_stats.recent_response_times) > 10:
                provider_stats.recent_response_times = provider_stats.recent_response_times[-10:]
            provider_stats.avg_response_time = sum(provider_stats.recent_response_times) / len(provider_stats.recent_response_times)
    
    async def get_best_provider(self) -> Optional[AIProvider]:
        """Get the best available provider based on health and performance."""
        async with self._lock:
            # If we have a current provider that's healthy, use it
            if self._current_provider and self._current_provider in self.providers:
                current = self.providers[self._current_provider]
                if current.status == ProviderStatus.HEALTHY:
                    return current
            
            # Otherwise, find the best provider
            best_provider = None
            best_score = -1
            
            for provider in self.providers.values():
                # Skip providers without valid API keys
                if not provider.api_key or provider.api_key.startswith("YOUR_"):
                    continue
                
                # Score: prioritize healthy, then by performance
                if provider.status == ProviderStatus.HEALTHY:
                    provider_stats = self.stats[provider.name]
                    score = provider_stats.success_rate * 100 - provider_stats.avg_response_time
                    if score > best_score:
                        best_score = score
                        best_provider = provider
                elif provider.status == ProviderStatus.RATE_LIMITED:
                    # Still consider rate-limited providers as fallback if no healthy ones
                    if best_provider is None:
                        best_provider = provider
                elif provider.status == ProviderStatus.UNKNOWN:
                    # Try unknown providers
                    if await self._test_provider(provider):
                        best_provider = provider
                        break
            
            if best_provider:
                self._current_provider = best_provider.name
                log.info(f"Selected AI provider: {best_provider.name} ({best_provider.model})")
            
            return best_provider
    
    async def call_llm(self, messages: list, temperature: float = 0.2, 
                     response_format: dict | None = None) -> dict:
        """Call the LLM with automatic failover."""
        max_retries = len(self.providers)
        
        for attempt in range(max_retries):
            provider = await self.get_best_provider()
            
            if not provider:
                raise Exception("No healthy AI providers available")
            
            try:
                client = await self._get_client()
                start = time.time()
                
                body = {
                    "model": provider.model,
                    "messages": messages,
                    "temperature": temperature
                }
                
                if response_format:
                    body["response_format"] = response_format
                
                response = await client.post(
                    f"{provider.base_url}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {provider.api_key}",
                        "Content-Type": "application/json"
                    },
                    json=body,
                    timeout=30
                )
                
                response_time = (time.time() - start) * 1000
                
                if response.status_code == 200:
                    provider.response_time_ms = response_time
                    provider.success_count += 1
                    provider.status = ProviderStatus.HEALTHY
                    provider.error_message = ""
                    self._update_stats(provider)
                    
                    content = response.json()["choices"][0]["message"]["content"]
                    # Remove markdown code blocks if present
                    if content.startswith("```json"):
                        content = content.replace("```json", "").replace("```", "").strip()
                    elif content.startswith("```"):
                        content = content.replace("```", "").strip()
                    
                    return {
                        "content": content,
                        "provider": provider.name,
                        "model": provider.model,
                        "response_time_ms": response_time,
                        "raw_response": response.json()
                    }
                elif response.status_code == 429:
                    provider.status = ProviderStatus.RATE_LIMITED
                    provider.failure_count += 1
                    provider.error_message = "Rate limited"
                    self._update_stats(provider)
                    log.warning(f"Provider {provider.name} rate limited, trying next...")
                    continue
                else:
                    provider.status = ProviderStatus.ERROR
                    provider.failure_count += 1
                    provider.error_message = f"HTTP {response.status_code}"
                    self._update_stats(provider)
                    log.warning(f"Provider {provider.name} failed with HTTP {response.status_code}, trying next...")
                    continue
                    
            except asyncio.TimeoutError:
                provider.status = ProviderStatus.SLOW
                provider.failure_count += 1
                provider.error_message = "Timeout"
                self._update_stats(provider)
                log.warning(f"Provider {provider.name} timed out, trying next...")
                continue
            except Exception as e:
                provider.status = ProviderStatus.ERROR
                provider.failure_count += 1
                provider.error_message = str(e)[:100]
                self._update_stats(provider)
                log.warning(f"Provider {provider.name} failed: {e}, trying next...")
                continue
        
        raise Exception("All AI providers failed")
    
    def get_status(self) -> Dict:
        """Get status of all providers."""
        return {
            provider.name: {
                "status": provider.status.value,
                "model": provider.model,
                "response_time_ms": provider.response_time_ms,
                "success_count": provider.success_count,
                "failure_count": provider.failure_count,
                "last_check": provider.last_check,
                "error_message": provider.error_message,
                "has_api_key": bool(provider.api_key and not provider.api_key.startswith("YOUR_")),
                "stats": {
                    "avg_response_time_ms": self.stats[provider.name].avg_response_time,
                    "success_rate": round(self.stats[provider.name].success_rate * 100, 1),
                    "total_requests": self.stats[provider.name].total_requests
                }
            }
            for provider in self.providers.values()
        }
    
    def get_current_provider_info(self) -> Dict:
        """Get information about the currently selected provider."""
        if self._current_provider and self._current_provider in self.providers:
            provider = self.providers[self._current_provider]
            return {
                "name": provider.name,
                "model": provider.model,
                "status": provider.status.value,
                "response_time_ms": provider.response_time_ms
            }
        return {"name": "none", "model": "none", "status": "unknown", "response_time_ms": 0}