package com.yuzhua.config;

import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.deser.LocalDateDeserializer;
import com.fasterxml.jackson.datatype.jsr310.deser.LocalDateTimeDeserializer;
import com.fasterxml.jackson.datatype.jsr310.deser.LocalTimeDeserializer;
import com.fasterxml.jackson.datatype.jsr310.ser.LocalDateSerializer;
import com.fasterxml.jackson.datatype.jsr310.ser.LocalDateTimeSerializer;
import com.fasterxml.jackson.datatype.jsr310.ser.LocalTimeSerializer;
import org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

/**
 * 统一 JSR-310 时间的 JSON 格式。
 *
 * 不配置的话 Jackson 默认走 ISO-8601（"2026-09-13T00:18:38"），
 * 而 Element Plus 的 date-picker / time-picker 用 value-format 提交的是
 * "2026-09-13" / "09:00:00"，反序列化会直接报 400。这里让出参入参都用同一套格式，
 * 前端无需任何转换。spring.jackson.date-format 只管 java.util.Date，管不到这几个类型。
 */
@Configuration
public class JacksonConfig {

    public static final String DATE_TIME_PATTERN = "yyyy-MM-dd HH:mm:ss";
    public static final String DATE_PATTERN = "yyyy-MM-dd";
    public static final String TIME_PATTERN = "HH:mm:ss";

    @Bean
    public Jackson2ObjectMapperBuilderCustomizer jsr310FormatCustomizer() {
        DateTimeFormatter dateTime = DateTimeFormatter.ofPattern(DATE_TIME_PATTERN);
        DateTimeFormatter date = DateTimeFormatter.ofPattern(DATE_PATTERN);
        DateTimeFormatter time = DateTimeFormatter.ofPattern(TIME_PATTERN);

        return builder -> builder
                .serializerByType(LocalDateTime.class, new LocalDateTimeSerializer(dateTime))
                .deserializerByType(LocalDateTime.class, new LocalDateTimeDeserializer(dateTime))
                .serializerByType(LocalDate.class, new LocalDateSerializer(date))
                .deserializerByType(LocalDate.class, new LocalDateDeserializer(date))
                .serializerByType(LocalTime.class, new LocalTimeSerializer(time))
                .deserializerByType(LocalTime.class, new LocalTimeDeserializer(time))
                .featuresToDisable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    }
}
