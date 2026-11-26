from datetime import datetime, timezone
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class MeasurementInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    seq: int = Field(ge=0)
    temperature: float = Field(ge=-40, le=125)
    humidity: float = Field(ge=0, le=100)
    vibration_rate: float = Field(ge=0, le=10000)
    vibration_edges: int = Field(ge=0, le=1000000)
    current_rms: float | None = Field(ge=0, le=1000)
    current_source: Literal["simulated", "hardware", "unavailable"]
    acquisition_mode: Literal["simulated", "hardware"]

    @model_validator(mode="after")
    def validate_current_availability(self):
        if self.current_source == "unavailable":
            if self.current_rms not in (None, 0):
                raise ValueError("Un courant indisponible ne peut pas porter de valeur mesurée")
            self.current_rms = None
        elif self.current_rms is None:
            raise ValueError("Une valeur de courant est requise lorsque sa source est disponible")
        return self


def timestamp_measurement(data: MeasurementInput) -> dict:
    return {**data.model_dump(), "recorded_at": datetime.now(timezone.utc)}
