package com.petclinic.config;

import jakarta.validation.Validation;
import jakarta.validation.Validator;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 配置项的启动期校验。租约有效期配成 0 或负数时必须在启动阶段失败，
 * 否则租约一到当前时刻就过期，多实例互斥会静默失效。
 */
class AppPropertiesValidationTest {

    private final Validator validator = Validation.buildDefaultValidatorFactory().getValidator();

    @Test
    void leaseSecondsMustBePositive() {
        AppProperties props = new AppProperties();

        props.getScheduler().setLeaseSeconds(0);
        var violations = validator.validate(props);
        assertThat(violations).isNotEmpty();
        assertThat(violations).extracting(v -> v.getPropertyPath().toString())
                .contains("scheduler.leaseSeconds");
        assertThat(violations).extracting(v -> v.getMessage())
                .contains("定时任务租约有效期必须大于 0 秒");

        props.getScheduler().setLeaseSeconds(-1);
        assertThat(validator.validate(props)).isNotEmpty();

        props.getScheduler().setLeaseSeconds(300);
        assertThat(validator.validate(props)).isEmpty();
    }
}