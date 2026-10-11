"""Whale transaction monitoring for enhanced AI analysis.

Tracks large cryptocurrency transactions that often precede significant price movements.
Integrates with news sentiment and technical indicators for comprehensive analysis.
"""
import asyncio
import logging
import os
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import httpx

from .config import settings

log = logging.getLogger("whale")


@dataclass
class WhaleTransaction:
    """Represents a significant whale transaction."""
    symbol: str
    transaction_type: str  # "buy" or "sell"
    amount_usd: float
    amount_coin: float
    price: float
    timestamp: datetime
    exchange: str
    score: float  # -1.0 (bearish) to 1.0 (bullish)


class WhaleMonitor:
    """Monitor whale transactions from various sources."""
    
    # Major market-moving coins to monitor regardless of portfolio
    MARKET_MOVERS = ["BTC", "ETH", "USDT", "USDC", "BNB"]
    
    def __init__(self):
        self._cache: Dict[str, List[WhaleTransaction]] = {}
        self._last_fetch: float = 0
        self._cache_ttl = 300  # 5 minutes
        self._whale_threshold_usd = settings.whale_threshold_usdt
        self._client: Optional[httpx.AsyncClient] = None
        self.api_key = settings.whale_alert_api_key
        self.api_url = settings.whale_alert_api_url
        
        # For backward compatibility
        self._whale_threshold_usd = self._whale_threshold_usd
        
    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30)
        return self._client
    
    async def close(self):
        """Clean up resources."""
        if self._client:
            await self._client.aclose()
            self._client = None
    
    async def fetch_whale_transactions(self, symbols: List[str]) -> Dict[str, List[WhaleTransaction]]:
        """Fetch recent whale transactions for given symbols + market movers."""
        now = time.time()
        if now - self._last_fetch < self._cache_ttl and self._cache:
            return {s: self._cache.get(s, []) for s in symbols}
        
        self._last_fetch = now
        self._cache.clear()
        
        try:
            # Always monitor market-moving coins regardless of portfolio
            all_symbols = list(set(symbols + [s + "USDT" for s in self.MARKET_MOVERS]))
            
            # Use real whale data if API key is configured, otherwise fall back to simulation
            for symbol in all_symbols:
                if self.api_key:
                    whale_txs = await self._fetch_real_whale_data(symbol)
                else:
                    whale_txs = await self._simulate_whale_data(symbol)
                self._cache[symbol] = whale_txs
                
            log.info("Fetched whale transactions for %d symbols (including market movers)", len(all_symbols))
            return {s: self._cache.get(s, []) for s in symbols}
            
        except Exception as e:
            log.warning("Whale data fetch failed: %s", e)
            return {s: [] for s in symbols}
    
    async def _fetch_real_whale_data(self, symbol: str) -> List[WhaleTransaction]:
        """Fetch real whale data from Whale Alert API."""
        if not self.api_key:
            log.warning("No Whale Alert API key configured, using simulated data")
            return await self._simulate_whale_data(symbol)
        
        try:
            client = await self._get_client()
            
            # Whale Alert API endpoint for recent transactions
            # Note: This is a placeholder - actual API endpoint may differ
            response = await client.get(
                f"{self.api_url}/transactions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                params={"symbol": symbol, "limit": 50}
            )
            
            if response.status_code == 200:
                data = response.json()
                whale_txs = []
                
                for tx in data.get("transactions", []):
                    whale_txs.append(WhaleTransaction(
                        symbol=symbol,
                        transaction_type=tx.get("type", "unknown"),
                        amount_usd=tx.get("amount_usd", 0),
                        amount_coin=tx.get("amount_coin", 0),
                        price=tx.get("price", 0),
                        timestamp=datetime.fromisoformat(tx.get("timestamp", datetime.now().isoformat())),
                        exchange=tx.get("exchange", "unknown"),
                        score=tx.get("score", 0.0)
                    ))
                
                log.info(f"Fetched {len(whale_txs)} real whale transactions for {symbol}")
                return whale_txs
            else:
                log.warning(f"Whale Alert API returned {response.status_code}")
                return await self._simulate_whale_data(symbol)
                
        except Exception as e:
            log.warning(f"Failed to fetch real whale data for {symbol}: {e}")
            return await self._simulate_whale_data(symbol)
    
    async def _simulate_whale_data(self, symbol: str) -> List[WhaleTransaction]:
        """Simulate whale transaction data (replace with real API in production)."""
        # This is a placeholder - replace with actual whale alert API integration
        # Example real APIs: Whale Alert, Etherscan, Binance Alerts
        
        import random
        whale_txs = []
        
        # Simulate occasional whale activity
        if random.random() < 0.3:  # 30% chance of whale activity
            tx_type = random.choice(["buy", "sell"])
            amount_usd = random.uniform(self._whale_threshold_usdt, self._whale_threshold_usdt * 10)
            
            whale_txs.append(WhaleTransaction(
                symbol=symbol,
                transaction_type=tx_type,
                amount_usd=amount_usd,
                amount_coin=amount_usd / 100,  # Simplified price
                price=100,  # Simplified
                timestamp=datetime.now(),
                exchange="Binance",
                score=0.8 if tx_type == "buy" else -0.8
            ))
        
        return whale_txs
    
    def analyze_whale_sentiment(self, transactions: List[WhaleTransaction]) -> Dict:
        """Analyze whale transactions for sentiment impact."""
        if not transactions:
            return {
                "score": 0.0,
                "label": "Neutral",
                "count": 0,
                "total_volume_usd": 0.0,
                "buy_volume": 0.0,
                "sell_volume": 0.0,
                "recent_signals": []
            }
        
        recent_txs = [tx for tx in transactions 
                     if datetime.now() - tx.timestamp < timedelta(hours=24)]
        
        buy_volume = sum(tx.amount_usd for tx in recent_txs if tx.transaction_type == "buy")
        sell_volume = sum(tx.amount_usd for tx in recent_txs if tx.transaction_type == "sell")
        total_volume = buy_volume + sell_volume
        
        if total_volume == 0:
            score = 0.0
        else:
            score = (buy_volume - sell_volume) / total_volume
        
        # Scale score based on volume significance
        volume_multiplier = min(total_volume / (self._whale_threshold_usd * 5), 2.0)
        final_score = score * volume_multiplier
        
        return {
            "score": round(max(-1.0, min(1.0, final_score)), 3),
            "label": "Bullish" if final_score > 0.2 else ("Bearish" if final_score < -0.2 else "Neutral"),
            "count": len(recent_txs),
            "total_volume_usd": round(total_volume, 2),
            "buy_volume": round(buy_volume, 2),
            "sell_volume": round(sell_volume, 2),
            "recent_signals": [
                {
                    "type": tx.transaction_type,
                    "amount_usd": round(tx.amount_usd, 2),
                    "timestamp": tx.timestamp.isoformat(),
                    "exchange": tx.exchange
                }
                for tx in recent_txs[-5:]  # Last 5 signals
            ]
        }
    
    def get_whale_impact_signal(self, whale_data: Dict, current_price: float) -> Optional[Dict]:
        """Generate trading signals based on whale activity."""
        if whale_data["count"] == 0:
            return None
        
        score = whale_data["score"]
        volume = whale_data["total_volume_usd"]
        
        # Only generate signals for significant whale activity
        if volume < self._whale_threshold_usd:
            return None
        
        signal = {
            "type": "buy" if score > 0.3 else ("sell" if score < -0.3 else "hold"),
            "confidence": abs(score),
            "reason": f"Whale activity: ${volume:,.0f} total volume, "
                     f"{'bullish' if score > 0 else 'bearish'} sentiment",
            "whale_score": score,
            "volume_significance": volume / self._whale_threshold_usd
        }
        
        return signal
    
    def calculate_market_wide_sentiment(self, all_whale_data: Dict[str, List[WhaleTransaction]]) -> Dict:
        """Calculate market-wide whale sentiment impact."""
        market_movers_data = {}
        
        # Analyze market-moving coins
        for mover in self.MARKET_MOVERS:
            symbol = mover + "USDT"
            txs = all_whale_data.get(symbol, [])
            analysis = self.analyze_whale_sentiment(txs)
            market_movers_data[mover] = analysis
        
        # Calculate weighted market sentiment
        total_volume = sum(data["total_volume_usd"] for data in market_movers_data.values())
        if total_volume == 0:
            return {
                "market_score": 0.0,
                "market_label": "Neutral",
                "total_volume": 0.0,
                "movers": market_movers_data,
                "impact_level": "none"
            }
        
        # Weight by volume (larger movements = more impact)
        weighted_score = sum(
            data["score"] * data["total_volume_usd"] 
            for data in market_movers_data.values()
        ) / total_volume
        
        # Determine impact level
        impact_level = "low"
        if total_volume > 10_000_000:  # $10M+
            impact_level = "medium"
        if total_volume > 50_000_000:  # $50M+
            impact_level = "high"
        if total_volume > 100_000_000:  # $100M+
            impact_level = "extreme"
        
        return {
            "market_score": round(weighted_score, 3),
            "market_label": "Bullish" if weighted_score > 0.2 else ("Bearish" if weighted_score < -0.2 else "Neutral"),
            "total_volume": round(total_volume, 2),
            "movers": market_movers_data,
            "impact_level": impact_level
        }


# Integration helper for the strategy engine
async def enhance_analysis_with_whales(
    whale_monitor: WhaleMonitor,
    symbols: List[str],
    current_analysis: Dict
) -> Dict:
    """Enhance existing analysis with whale data."""
    whale_transactions = await whale_monitor.fetch_whale_transactions(symbols)
    
    enhanced = current_analysis.copy()
    enhanced["whale_data"] = {}
    
    # Calculate market-wide sentiment from major coins
    market_wide_sentiment = whale_monitor.calculate_market_wide_sentiment(whale_transactions)
    enhanced["market_whale_sentiment"] = market_wide_sentiment
    
    for symbol in symbols:
        txs = whale_transactions.get(symbol, [])
        whale_analysis = whale_monitor.analyze_whale_sentiment(txs)
        whale_signal = whale_monitor.get_whale_impact_signal(whale_analysis, 0)
        
        # Combine coin-specific and market-wide sentiment
        combined_score = (whale_analysis["score"] + market_wide_sentiment["market_score"]) / 2
        
        enhanced["whale_data"][symbol] = {
            "analysis": whale_analysis,
            "signal": whale_signal,
            "has_recent_activity": whale_analysis["count"] > 0,
            "combined_score": round(combined_score, 3),
            "market_impact": market_wide_sentiment["impact_level"]
        }
    
    return enhanced