from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('health', Path(__file__).with_name('collect-sbc-runtime-health.py'))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class ForecastAlertTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 24, tzinfo=timezone.utc)
        self.previous = {}

    def step(self, days, status='growing', minutes=1):
        self.now += timedelta(minutes=minutes)
        info = {'forecastStatus': status, 'daysUntilReserveExhaustion': days}
        result = health.advance_capacity_forecast(info, self.previous, self.now)
        self.previous = {'capacity': {'forecastAlert': result}}
        return result

    def test_short_peaks_and_boundary_flapping_do_not_alert(self):
        for _ in range(60):
            self.assertFalse(self.step(29)['active'])
            self.assertFalse(self.step(23)['active'])
            self.assertFalse(self.step(30.8)['active'])

    def test_sustained_failure_hysteresis_and_recovery(self):
        self.step(29)
        for _ in range(29):
            self.assertFalse(self.step(29)['active'])
        self.assertTrue(self.step(29)['active'])
        for _ in range(40):
            self.assertTrue(self.step(34.99)['active'])
        self.step(35)
        for _ in range(29):
            self.assertTrue(self.step(35)['active'])
        self.assertFalse(self.step(35)['active'])

    def test_unknown_and_collection_gap_cannot_confirm_recovery(self):
        self.previous = {'critical': [{'id': 'capacity:forecast'}]}
        self.assertTrue(self.step(None, 'unknown')['active'])
        self.step(40)
        self.assertTrue(self.step(40, minutes=31)['active'])
        self.assertTrue(self.step(None, 'insufficient-samples')['active'])
        self.assertIsNone(self.previous['capacity']['forecastAlert']['recoveryStartedAt'])

    def test_no_growth_can_recover_and_future_timestamp_is_rejected(self):
        self.previous = {'capacity': {'forecastAlert': {'active': True}}}
        for _ in range(31):
            result = self.step(None, 'no-positive-growth')
        self.assertFalse(result['active'])
        self.previous['capacity']['forecastAlert']['breachStartedAt'] = (self.now + timedelta(days=1)).isoformat()
        self.assertFalse(self.step(20)['active'])


if __name__ == '__main__':
    unittest.main()
